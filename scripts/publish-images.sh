#!/usr/bin/env bash
# Publish tracked source and the pinned TLS proxy into one selected target account.
set -euo pipefail

: "${TARGET_ACCOUNT:?Set the intended twelve-digit AWS account ID}"
: "${AWS_REGION:?Set the intended AWS region}"
: "${BOOTSTRAP_STACK:?Set the owning runtime bootstrap stack name}"
[[ "$TARGET_ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "Invalid target account." >&2; exit 2; }
build_options=()
if [[ -n "${BUILD_CA_FILE:-}" ]]; then
  [[ -r "$BUILD_CA_FILE" ]] || { echo "Build CA certificate is unreadable." >&2; exit 2; }
  build_options+=(--secret "id=build_ca,src=$BUILD_CA_FILE")
fi
export AWS_PAGER=''
account=$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)
[[ "$account" == "$TARGET_ACCOUNT" ]] || { echo "AWS identity does not match the intended account." >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
cd "$root"
commit=$(git rev-parse HEAD)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/docker" "$work/source"
git archive "$commit" | tar -x -C "$work/source"
stack_output() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
repo=$(stack_output ImageRepositoryName)
uri=$(stack_output ImageRepositoryUri)
registry=${uri%%/*}
[[ "$registry" == "$TARGET_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com" && "$uri" == "$registry/$repo" ]] || {
  echo "Registry does not belong to the selected account, region and stack." >&2; exit 2;
}
# Keep Docker's temporary ECR login out of the operator's persistent credential store.
export DOCKER_CONFIG="$work/docker"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry" >&2
publish() {
  local tag="$1" dockerfile="$2" out
  if ! out=$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$repo" --image-ids "imageTag=$tag" \
      --query 'imageDetails[0].imageDigest' --output text 2>"$work/lookup-error"); then
    if ! grep -q '(ImageNotFoundException)' "$work/lookup-error"; then cat "$work/lookup-error" >&2; return 1; fi
    docker buildx build "${build_options[@]}" --platform linux/amd64 --file "$work/source/$dockerfile" --tag "$uri:$tag" --push "$work/source" >&2 || return 1
    out=$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$repo" --image-ids "imageTag=$tag" \
      --query 'imageDetails[0].imageDigest' --output text) || return 1
  fi
  [[ "$out" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "ECR returned an invalid manifest digest." >&2; return 1; }
  printf '%s@%s\n' "$uri" "$out"
}
proxy_id=$(git rev-parse "$commit:infra/Proxy.Dockerfile")
# An immutable target tag allows a retry to reuse an image after a partial publication.
app_image=$(publish "platform-$commit" Dockerfile)
proxy_image=$(publish "proxy-$proxy_id" infra/Proxy.Dockerfile)
printf '{"appImage":"%s","proxyImage":"%s"}\n' "$app_image" "$proxy_image"
