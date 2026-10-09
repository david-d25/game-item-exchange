#!/usr/bin/env bash
# Creates the local k3d cluster with Kafka and deploys the platform.
# Safe to run again: every step skips or updates what already exists.
set -euo pipefail

# Git Bash on Windows: do not turn /paths/inside/containers into C:/... paths
export MSYS_NO_PATHCONV=1

# Run from the repository root, wherever the script is called from
cd "$(dirname "$0")/.."

CLUSTER=gie
STRIMZI_VERSION=1.2.0

echo "==> Cluster"
if k3d cluster get "$CLUSTER" > /dev/null 2>&1; then
  echo "Cluster $CLUSTER already exists"
else
  k3d cluster create --config deploy/k3d/cluster.yaml
fi

echo "==> Strimzi operator $STRIMZI_VERSION"
helm repo add strimzi https://strimzi.io/charts/ --force-update > /dev/null
helm upgrade --install strimzi strimzi/strimzi-kafka-operator \
  --namespace kafka --create-namespace \
  --version "$STRIMZI_VERSION" \
  --wait

echo "==> Kafka"
kubectl apply -k deploy/infra/kafka
kubectl -n kafka wait kafka/exchange --for=condition=Ready --timeout=600s

scripts/deploy.sh
