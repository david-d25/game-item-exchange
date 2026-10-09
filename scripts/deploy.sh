#!/usr/bin/env bash
# Builds the images, loads them into the cluster and rolls out the platform.
# Run after every code change. Expects the cluster from cluster-up.sh.
set -euo pipefail

# Git Bash on Windows: do not turn /paths/inside/containers into C:/... paths
export MSYS_NO_PATHCONV=1

# Run from the repository root, wherever the script is called from
cd "$(dirname "$0")/.."

CLUSTER=gie
NAMESPACE=gie
IMAGES=(game-item-exchange/core:dev game-item-exchange/matcher:dev)
DEPLOYMENTS=(core-api core-relay matcher)

echo "==> Images"
./gradlew :platform:core:jibDockerBuild :platform:matcher:jibDockerBuild
k3d image import "${IMAGES[@]}" -c "$CLUSTER"

echo "==> Manifests"
kubectl apply -k deploy/k8s/overlays/local
kubectl -n "$NAMESPACE" rollout status statefulset postgres --timeout=300s

echo "==> Rollout"
# The tag is always "dev", so Kubernetes cannot notice a new image by itself: restart explicitly
kubectl -n "$NAMESPACE" rollout restart deployment "${DEPLOYMENTS[@]}"
for deployment in "${DEPLOYMENTS[@]}"; do
  kubectl -n "$NAMESPACE" rollout status deployment "$deployment" --timeout=300s
done

echo "Platform is up: http://localhost:8081/api"
