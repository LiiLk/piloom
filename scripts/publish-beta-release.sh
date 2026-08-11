#!/usr/bin/env bash

# Publish the mutable beta release as a recoverable transaction.  The old
# release is renamed to a private backup before its tag is moved; its assets
# therefore remain available for rollback until the new release is published.
set -Eeuo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${BETA_VERSION:?BETA_VERSION is required}"
: "${BUILD_COMMIT:?BUILD_COMMIT is required}"
: "${BETA_DIR:?BETA_DIR is required}"
: "${WINDOWS_DIR:?WINDOWS_DIR is required}"
: "${INSTALLER_DIR:?INSTALLER_DIR is required}"

readonly repo="$GITHUB_REPOSITORY"
readonly beta_tag="beta"
readonly candidate_tag="beta-candidate"
readonly backup_tag="beta-backup"
readonly snapshot_dir="$(mktemp -d)"
readonly candidate_verify_dir="$snapshot_dir/candidate"
readonly old_body_path="$snapshot_dir/old-body.md"
readonly beta_notes_path="${BETA_NOTES_PATH:-/tmp/beta-release-notes.md}"
readonly gh_bin="${PILOOM_GH_BIN:-gh}"
readonly jq_bin="${PILOOM_JQ_BIN:-jq}"

candidate_id=""
backup_id=""
old_release_id=""
old_release_exists=0
old_release_was_draft=false
old_release_was_prerelease=true
old_release_name=""
old_tag_sha=""
old_tag_exists=0
old_release_renamed=0
transaction_succeeded=0
mutation_started=0
rollback_failed=0
failpoint_seen=0

cleanup() {
	rm -rf "$snapshot_dir"
}

gh_api() {
	"$gh_bin" api "$@"
}

gh_cli() {
	"$gh_bin" "$@"
}

jq_cli() {
	"$jq_bin" "$@"
}

# A draft release has no git tag yet, so GitHub answers 404 when it is looked up
# by tag name. This transaction deliberately parks releases as drafts (the
# candidate, and the backup during cutover), so lookups fall back to the release
# list, which does include drafts.
draft_release_view() {
	local tag="$1"
	local response_path error_path
	response_path=$(mktemp "$snapshot_dir/draft-view.XXXXXX.json")
	error_path=$(mktemp "$snapshot_dir/draft-view.XXXXXX.err")
	if ! gh_api "repos/${repo}/releases?per_page=100" \
		--jq "[.[] | select(.tag_name == \"${tag}\")] | first // empty" >"$response_path" 2>"$error_path"; then
		echo "Could not list GitHub releases to find ${tag}; refusing to mutate release state." >&2
		cat "$error_path" >&2
		rm -f "$response_path" "$error_path"
		return 2
	fi
	# `--jq ... // empty` still prints a newline when nothing matches.
	if [[ -z "$(tr -d '[:space:]' <"$response_path")" ]]; then
		rm -f "$response_path" "$error_path"
		return 1
	fi
	cat "$response_path"
	rm -f "$response_path" "$error_path"
	return 0
}

release_view() {
	local tag="$1"
	local response_path error_path status
	response_path=$(mktemp "$snapshot_dir/release-view.XXXXXX.json")
	error_path=$(mktemp "$snapshot_dir/release-view.XXXXXX.err")
	if gh_api "repos/${repo}/releases/tags/${tag}" >"$response_path" 2>"$error_path"; then
		cat "$response_path"
		rm -f "$response_path" "$error_path"
		return 0
	fi
	if grep -Eq '\(HTTP 404\)|^HTTP/[0-9.]+ 404([[:space:]]|$)' "$error_path"; then
		rm -f "$response_path" "$error_path"
		if draft_release_view "$tag"; then
			return 0
		else
			status=$?
		fi
		return "$status"
	fi
	echo "Could not inspect GitHub release ${tag}; refusing to mutate release state." >&2
	cat "$error_path" >&2
	rm -f "$response_path" "$error_path"
	return 2
}

release_id_for_tag() {
	local tag="$1"
	local json status id
	if json=$(release_view "$tag"); then
		id=$(printf '%s\n' "$json" | jq_cli -r '.id')
		# Never hand an empty id to a caller: it would turn a delete or patch
		# into a request against the whole releases collection.
		if [[ -z "$id" || "$id" == "null" ]]; then
			echo "GitHub release ${tag} has no id; refusing to mutate release state." >&2
			return 2
		fi
		printf '%s\n' "$id"
		return 0
	else
		status=$?
	fi
	return "$status"
}

tag_sha_for_tag() {
	local tag="$1"
	local response_path error_path
	response_path=$(mktemp "$snapshot_dir/tag-view.XXXXXX.txt")
	error_path=$(mktemp "$snapshot_dir/tag-view.XXXXXX.err")
	if gh_api "repos/${repo}/git/ref/tags/${tag}" --jq '.object.sha' >"$response_path" 2>"$error_path"; then
		cat "$response_path"
		rm -f "$response_path" "$error_path"
		return 0
	fi
	if grep -Eq '\(HTTP 404\)|^HTTP/[0-9.]+ 404([[:space:]]|$)' "$error_path"; then
		rm -f "$response_path" "$error_path"
		return 1
	fi
	echo "Could not inspect GitHub tag ${tag}; refusing to mutate release state." >&2
	cat "$error_path" >&2
	rm -f "$response_path" "$error_path"
	return 2
}

failpoint() {
	local name="$1"
	if [[ "${PILOOM_BETA_FAILPOINT:-}" == "$name" && "$failpoint_seen" == 0 ]]; then
		failpoint_seen=1
		echo "beta publication failpoint: $name" >&2
		return 97
	fi
}

delete_tag_if_present() {
	local tag="$1"
	local status
	if tag_sha_for_tag "$tag" >/dev/null; then
		gh_api --method DELETE "repos/${repo}/git/refs/tags/${tag}" >/dev/null
	else
		status=$?
		if [[ "$status" != 1 ]]; then
			return "$status"
		fi
	fi
}

delete_release_and_tag() {
	local tag="$1"
	local id status
	if id=$(release_id_for_tag "$tag"); then
		gh_api --method DELETE "repos/${repo}/releases/${id}" >/dev/null
	else
		status=$?
		if [[ "$status" != 1 ]]; then
			return "$status"
		fi
	fi
	delete_tag_if_present "$tag"
}

restore_tag() {
	local tag="$1"
	local sha="$2"
	local status
	if [[ -z "$sha" ]]; then
		return 0
	fi
	if tag_sha_for_tag "$tag" >/dev/null; then
		gh_api --method PATCH "repos/${repo}/git/refs/tags/${tag}" -F "sha=${sha}" -F force=true >/dev/null
	else
		status=$?
		if [[ "$status" != 1 ]]; then
			return "$status"
		fi
		gh_api --method POST "repos/${repo}/git/refs" -f "ref=refs/tags/${tag}" -f "sha=${sha}" >/dev/null
	fi
}

write_release_body() {
	local json_path="$1"
	jq_cli -r '.body // ""' "$json_path" > "$old_body_path"
}

restore_release_from_backup() {
	local id="$1"
	local json_path="$2"
	local draft_override="${3:-}"
	local draft prerelease name target
	draft=$(jq_cli -r '.draft // false' "$json_path")
	if [[ -n "$draft_override" ]]; then
		draft="$draft_override"
	fi
	prerelease=$(jq_cli -r '.prerelease // true' "$json_path")
	name=$(jq_cli -r '.name // "Beta"' "$json_path")
	target=$(jq_cli -r '.target_commitish // empty' "$json_path")
	if [[ -z "$target" ]]; then
		target="$old_tag_sha"
	fi

	# Restore the ref before recreating/renaming the release.  This is safe if
	# the previous run died after deleting the beta ref.
	restore_tag "$beta_tag" "$target"
	gh_api --method PATCH "repos/${repo}/releases/${id}" \
		-f "tag_name=${beta_tag}" \
		-f "target_commitish=${target}" \
		-f "name=${name}" \
		-f "body=$(cat "$old_body_path")" \
		-F "draft=${draft}" \
		-F "prerelease=${prerelease}" >/dev/null
}

restore_stale_backup() {
	local json_path="$1"
	backup_id=$(jq_cli -r '.id' "$json_path")
	old_tag_sha=$(jq_cli -r '.target_commitish // empty' "$json_path")
	if [[ -z "$old_tag_sha" ]]; then
		echo "Stale ${backup_tag} release has no original commit snapshot; refusing automatic recovery." >&2
		return 1
	fi
	write_release_body "$json_path"
	# The backup is draft only because the interrupted transaction hid it.
	# Restore the public beta invariant before starting a fresh attempt.
	restore_release_from_backup "$backup_id" "$json_path" false
	delete_tag_if_present "$backup_tag"
	delete_release_and_tag "$candidate_tag"
	backup_id=""
}

restore_old_release_after_failure() {
	local lookup_status
	set +e
	echo "Beta publication failed; restoring the previous beta release." >&2

	# The candidate may already have been renamed to beta.  Delete it by id so
	# rollback never relies on a potentially stale tag lookup.
	if [[ -z "$candidate_id" ]]; then
		if candidate_id=$(release_id_for_tag "$candidate_tag"); then
			:
		else
			lookup_status=$?
			candidate_id=""
			if [[ "$lookup_status" != 1 ]]; then
				echo "rollback: could not inspect candidate release" >&2
				rollback_failed=1
			fi
		fi
	fi
	if [[ -n "$candidate_id" ]]; then
		if ! gh_api --method DELETE "repos/${repo}/releases/${candidate_id}" >/dev/null 2>&1; then
			echo "rollback: could not delete candidate release ${candidate_id}" >&2
			rollback_failed=1
		fi
	fi
	if tag_sha_for_tag "$candidate_tag" >/dev/null; then
		if ! gh_api --method DELETE "repos/${repo}/git/refs/tags/${candidate_tag}" >/dev/null 2>&1; then
			echo "rollback: could not delete candidate tag" >&2
			rollback_failed=1
		fi
	else
		lookup_status=$?
		if [[ "$lookup_status" != 1 ]]; then
			echo "rollback: could not inspect candidate tag" >&2
			rollback_failed=1
		fi
	fi

	if [[ "$old_release_exists" == 1 ]]; then
		if [[ "$old_release_renamed" == 1 ]]; then
			if [[ -z "$backup_id" ]]; then
				if backup_id=$(release_id_for_tag "$backup_tag"); then
					:
				else
					lookup_status=$?
					backup_id=""
					if [[ "$lookup_status" != 1 ]]; then
						echo "rollback: could not inspect backup release" >&2
						rollback_failed=1
					fi
				fi
			fi
			if [[ -n "$backup_id" ]]; then
				if ! restore_release_from_backup "$backup_id" "$snapshot_dir/old-release.json" >/dev/null 2>&1; then
					echo "rollback: could not restore the previous release from ${backup_tag}" >&2
					rollback_failed=1
				else
					# The release id now belongs to beta again; never run the
					# post-rollback backup cleanup against the restored release.
					backup_id=""
					gh_api --method DELETE "repos/${repo}/git/refs/tags/${backup_tag}" >/dev/null 2>&1 || true
				fi
			else
				echo "rollback: backup release ${backup_tag} is missing" >&2
				rollback_failed=1
			fi
		elif [[ "$old_release_id" != "" ]]; then
			# The old release was only drafted, or the cutover failed before the
			# rename.  Restore its original visibility without touching assets.
			local draft_flag prerelease_flag
			draft_flag="$old_release_was_draft"
			prerelease_flag="$old_release_was_prerelease"
			if ! gh_cli release edit "$beta_tag" --draft="$draft_flag" --prerelease="$prerelease_flag" >/dev/null 2>&1; then
				echo "rollback: could not restore beta release visibility" >&2
				rollback_failed=1
			fi
		fi
		if [[ "$old_tag_exists" == 1 && -n "$old_tag_sha" ]]; then
			if ! restore_tag "$beta_tag" "$old_tag_sha"; then
				echo "rollback: could not restore beta tag ${old_tag_sha}" >&2
				rollback_failed=1
			fi
		fi
	else
		# There was no release at the start.  Leave no partially published beta.
		if ! delete_release_and_tag "$beta_tag"; then
			echo "rollback: could not remove the partial beta release" >&2
			rollback_failed=1
		fi
		if [[ "$old_tag_exists" == 1 && -n "$old_tag_sha" ]]; then
			if ! restore_tag "$beta_tag" "$old_tag_sha"; then
				echo "rollback: could not restore the pre-existing beta tag" >&2
				rollback_failed=1
			fi
		fi
	fi

	# A backup tag is deliberately retained if cleanup fails: it is the last
	# recoverable copy of the old assets and must not be silently discarded.
	if [[ "$rollback_failed" == 0 && -n "$backup_id" ]]; then
		if gh_api --method DELETE "repos/${repo}/releases/${backup_id}" >/dev/null 2>&1; then
			gh_api --method DELETE "repos/${repo}/git/refs/tags/${backup_tag}" >/dev/null 2>&1 || true
		else
			echo "rollback: retaining ${backup_tag}; backup cleanup failed" >&2
			rollback_failed=1
		fi
	fi
}

on_exit() {
	local status=$?
	if [[ "$status" != 0 && "$transaction_succeeded" == 0 && "$mutation_started" == 1 ]]; then
		restore_old_release_after_failure
		if [[ "$rollback_failed" != 0 ]]; then
			echo "ROLLBACK_FAILED: manual GitHub release recovery is required." >&2
		fi
	fi
	cleanup
	exit "$status"
}
trap on_exit EXIT
# Without this, an unexpected failure only prints the rollback notice, which is
# impossible to act on from a CI log. Reporting is all it does; the EXIT trap
# still decides what to roll back.
trap 'echo "beta publication error at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

for required_path in "$BETA_DIR" "$WINDOWS_DIR" "$INSTALLER_DIR"; do
	test -d "$required_path"
done

candidate_assets=()
for artifact in "$BETA_DIR"/* \
	"$WINDOWS_DIR/piloom-${BETA_VERSION}-windows-x64.zip" \
	"$WINDOWS_DIR/piloom-${BETA_VERSION}-windows-x64.zip.sha256" \
	"$WINDOWS_DIR/piloom-${BETA_VERSION}-windows-x64.zip.sha256.sig" \
	"$INSTALLER_DIR/install-beta.sh" \
	"$INSTALLER_DIR/install-beta.ps1"; do
	if [[ ! -f "$artifact" ]]; then
		echo "Missing beta release artifact: $artifact" >&2
		exit 1
	fi
	candidate_assets+=("$artifact")
done

mkdir -p "$candidate_verify_dir"

# Recover a transaction whose runner died before the EXIT trap. Every release
# lookup is tri-state: present, confirmed 404, or fatal API error. No mutation
# starts while the initial GitHub state is unknown.
recovery_beta_json="$snapshot_dir/recovery-beta.json"
if release_view "$beta_tag" > "$recovery_beta_json"; then
	if [[ "$(jq_cli -r '.draft // false' "$recovery_beta_json")" == false ]]; then
		delete_release_and_tag "$candidate_tag"
		delete_release_and_tag "$backup_tag"
	else
		backup_json="$snapshot_dir/stale-backup.json"
		if release_view "$backup_tag" > "$backup_json"; then
			delete_release_and_tag "$beta_tag"
			restore_stale_backup "$backup_json"
		else
			status=$?
			if [[ "$status" != 1 ]]; then
				exit "$status"
			fi
			candidate_target=$(jq_cli -r '.target_commitish // empty' "$recovery_beta_json")
			candidate_name=$(jq_cli -r '.name // ""' "$recovery_beta_json")
			if [[ "$candidate_target" != "$BUILD_COMMIT" || "$candidate_name" != "Beta (v${BETA_VERSION})" ]]; then
				echo "Draft beta has no backup and is not the expected interrupted candidate; refusing recovery." >&2
				exit 1
			fi
			delete_release_and_tag "$beta_tag"
			delete_release_and_tag "$candidate_tag"
		fi
	fi
else
	status=$?
	if [[ "$status" != 1 ]]; then
		exit "$status"
	fi
	backup_json="$snapshot_dir/stale-backup.json"
	if release_view "$backup_tag" > "$backup_json"; then
		restore_stale_backup "$backup_json"
	else
		status=$?
		if [[ "$status" != 1 ]]; then
			exit "$status"
		fi
		delete_release_and_tag "$candidate_tag"
	fi
fi

old_release_json="$snapshot_dir/old-release.json"
if release_view "$beta_tag" > "$old_release_json"; then
	old_release_exists=1
	old_release_id=$(jq_cli -r '.id' "$old_release_json")
	old_release_was_draft=$(jq_cli -r '.draft // false' "$old_release_json")
	old_release_was_prerelease=$(jq_cli -r '.prerelease // true' "$old_release_json")
	old_release_name=$(jq_cli -r '.name // "Beta"' "$old_release_json")
	write_release_body "$old_release_json"
else
	status=$?
	if [[ "$status" != 1 ]]; then
		exit "$status"
	fi
fi

if old_tag_sha=$(tag_sha_for_tag "$beta_tag"); then
	old_tag_exists=1
else
	status=$?
	if [[ "$status" != 1 ]]; then
		exit "$status"
	fi
fi
if [[ "$old_release_exists" == 1 && -z "$old_tag_sha" ]]; then
	echo "Could not snapshot the existing beta tag; refusing to publish." >&2
	exit 1
fi

# Build the complete candidate while the current public release is untouched.
# The id comes straight from the creation response: looking the draft up
# afterwards raced with GitHub making it visible in the release list, and a
# draft cannot be resolved by tag name at all.
mutation_started=1
candidate_id=$(gh_api --method POST "repos/${repo}/releases" \
	-f "tag_name=${candidate_tag}" \
	-f "target_commitish=${BUILD_COMMIT}" \
	-f "name=Beta (v${BETA_VERSION})" \
	-f "body=$(cat "$beta_notes_path")" \
	-F draft=true \
	-F prerelease=true \
	--jq '.id')
if [[ -z "$candidate_id" || "$candidate_id" == "null" ]]; then
	echo "Could not resolve the candidate release id." >&2
	exit 1
fi

gh_cli release upload "$candidate_tag" "${candidate_assets[@]}"
for artifact in "${candidate_assets[@]}"; do
	asset_name=$(basename "$artifact")
	gh_cli release download "$candidate_tag" --pattern "$asset_name" --dir "$candidate_verify_dir" --clobber
	if ! cmp -s "$artifact" "$candidate_verify_dir/$asset_name"; then
		echo "Candidate asset verification failed: $asset_name" >&2
		exit 1
	fi
done
failpoint upload

if [[ "$old_release_exists" == 1 ]]; then
	# Keep old assets in the backup release.  Only the release/tag pointers are
	# changed during cutover, making rollback independent of another download.
	# Drafting and renaming happen in one API mutation, so a killed runner never
	# leaves the old release stranded as an indistinguishable draft under beta.
	gh_api --method PATCH "repos/${repo}/releases/${old_release_id}" \
		-f "tag_name=${backup_tag}" \
		-f "target_commitish=${old_tag_sha}" \
		-f "name=${old_release_name}" \
		-f "body=$(cat "$old_body_path")" \
		-F draft=true \
		-F "prerelease=${old_release_was_prerelease}" >/dev/null
	old_release_renamed=1
	backup_id="$old_release_id"
	failpoint draft
fi

# Remove only the old pointer; release assets are still held by backup_tag.
delete_tag_if_present "$beta_tag"
failpoint delete

gh_api --method POST "repos/${repo}/git/refs" -f "ref=refs/tags/${beta_tag}" -f "sha=${BUILD_COMMIT}" >/dev/null
gh_api --method PATCH "repos/${repo}/releases/${candidate_id}" \
	-f "tag_name=${beta_tag}" \
	-f "target_commitish=${BUILD_COMMIT}" \
	-f "name=Beta (v${BETA_VERSION})" \
	-f "body=$(cat "$beta_notes_path")" \
	-F draft=true \
	-F prerelease=true >/dev/null
failpoint tag

failpoint publish
gh_cli release edit "$beta_tag" \
	--title "Beta (v${BETA_VERSION})" \
	--target "$BUILD_COMMIT" \
	--notes-file "$beta_notes_path" \
	--prerelease \
	--draft=false >/dev/null

if ! release_view "$beta_tag" | jq_cli -e '.draft == false and .prerelease == true and .tag_name == "beta"' >/dev/null; then
	echo "Published beta release did not have the expected public metadata." >&2
	exit 1
fi
transaction_succeeded=1

# The release now uses beta; the temporary candidate ref is no longer needed.
gh_api --method DELETE "repos/${repo}/git/refs/tags/${candidate_tag}" >/dev/null 2>&1 || true

# Cleanup is deliberately last and non-fatal: retaining beta-backup is safer
# than losing the previous signed assets if GitHub rejects the cleanup call.
if [[ -n "$backup_id" ]]; then
	if ! gh_api --method DELETE "repos/${repo}/releases/${backup_id}" >/dev/null 2>&1; then
		echo "warning: retaining ${backup_tag}; cleanup failed after successful beta publication" >&2
	else
		gh_api --method DELETE "repos/${repo}/git/refs/tags/${backup_tag}" >/dev/null 2>&1 || true
	fi
fi
echo "Beta installer: https://github.com/${repo}/releases/download/beta/install-beta.sh"
