# Deployment

Everything runs on Kubernetes, in two environments built from the same manifests
([k8s/base](k8s/base)) with a kustomize overlay each:

| | Local ([k8s/overlays/local](k8s/overlays/local)) | Production ([k8s/overlays/prod](k8s/overlays/prod)) |
|---|---|---|
| Cluster | k3d: k3s in Docker, three nodes | k3s on a VDS shared with other projects |
| core | 2 API replicas with settlement, 1 relay | 1 process doing all three |
| matcher | 2 instances, partitions split between them | 1 instance with all 12 partitions |
| Kafka | Strimzi, topics from `KafkaTopic` resources | one `apache/kafka-native` broker, topics created by core |
| Postgres | StatefulSet | StatefulSet |
| Way in | Traefik Ingress on localhost:8081 | the host's nginx (TLS) → NodePort on 127.0.0.1 |
| Monitoring | Prometheus, Grafana with a dashboard | `kubectl top`, logs |
| Users | Alice and Bob from the dev seed, `X-Dev-User-Id` | guests only |

The production overlay is the local shape made smaller, because the server has a few gigabytes of memory
shared with other projects: Strimzi alone (operator, topic operator, JVM broker) would need about a gigabyte,
more than the whole exchange, and so would the Prometheus stack. Expected use is about a gigabyte in total,
half of it k3s itself.

## Local cluster

```sh
scripts/cluster-up.sh   # once: the cluster, Prometheus and Grafana, Strimzi, Kafka, then the platform
scripts/deploy.sh       # after every change: build the images, load them into the cluster, roll out
```

The site is at http://localhost:8081/exchange/; Grafana at http://localhost:3000 after
`kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80` (admin / admin-local-only).

## Production

Every push to `main` is built, tested and deployed by [.github/workflows/deploy.yml](../.github/workflows/deploy.yml):

1. core and the matcher are built by Jib, the web app and the bots by Docker, and all four images are
   pushed to GHCR tagged with the commit;
2. the deploy job pins those tags in the prod overlay, copies `deploy/k8s` to the server over SSH and runs
   `kubectl apply -k` there;
3. it waits for every Deployment and StatefulSet to roll out, and fails if one does not within five minutes.

Nothing is built on the server, and the server needs no access to the repository.

### One-time setup on the server

**k3s.** Without Traefik and the service load balancer, which would take ports 80 and 443 from the host's
nginx, and with node ports on 127.0.0.1 only:

```sh
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/config.yaml > /dev/null <<'EOF'
disable:
  - traefik
  - servicelb
kube-proxy-arg:
  - nodeport-addresses=127.0.0.1/32
EOF
curl -sfL https://get.k3s.io | sudo sh -
sudo k3s kubectl get nodes   # Ready after half a minute
```

k3s runs its own containerd and does not touch Docker; the Compose projects keep running as they are.
The API server (6443) and the kubelet (10250) listen on all interfaces and require authentication;
if the provider has a firewall, close both to the outside.

**kubectl for the deploy user.** The `deploy` user of the other projects runs the deploys. It gets the
cluster's admin kubeconfig, which grants nothing new: membership of the `docker` group is already
equivalent to root.

```sh
sudo install -d -o deploy -g deploy -m 700 /home/deploy/.kube
sudo install -o deploy -g deploy -m 600 /etc/rancher/k3s/k3s.yaml /home/deploy/.kube/config
sudo install -d -o deploy -g deploy /srv/game-item-exchange
```

**Secrets.** Created once and never stored in git. As `deploy`, whose kubeconfig was copied above;
other users have none, and kubectl then tries `localhost:8080` and fails:

```sh
sudo -iu deploy
kubectl get nodes   # the node, Ready: kubectl reaches k3s
kubectl create namespace gie --save-config   # --save-config: later `kubectl apply` updates it quietly
kubectl -n gie create secret generic postgres \
  --from-literal=username=core \
  --from-literal=password="$(openssl rand -hex 24)"
kubectl -n gie create secret generic core-secrets \
  --from-literal=auth-secret="$(openssl rand -base64 48)" \
  --from-literal=internal-token="$(openssl rand -hex 32)"
```

`auth-secret` signs the users' tokens: changing it signs everyone out, and guests lose their accounts,
since the token is their only key.

**The host's nginx.** One rule. The prefix is *not* stripped: the gateway serves the site under `/exchange/`
and the API under `/exchange/api/`.

```nginx
location /exchange/ {
    proxy_pass         http://127.0.0.1:30080;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}

location = /exchange {
    return 301 /exchange/;
}
```

The gateway limits requests per client address and takes that address from `X-Real-IP`, so the header
is required: without it every visitor would share one limit.

### GitHub

Repository **variables** (Settings → Secrets and variables → Actions), the same as for the other projects
on this server except the path:

| | |
|---|---|
| `DEPLOY_HOST` | the VDS |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PATH` | `/srv/game-item-exchange` |
| `DEPLOY_HOST_KEY` | optional: the host's line from `ssh-keyscan -t ed25519 <host>`, to pin it |

Repository **secret**: `DEPLOY_KEY`, the private half of the deploy key.

Until `DEPLOY_HOST` is set the deploy job is skipped, so building and publishing work from the first commit.

The first push **creates the four packages as private** (`game-item-exchange/core`, `matcher`, `web` and
`bots`), and k3s cannot pull them: pods stay in `ImagePullBackOff` and the deploy job fails. Make them public
(Package settings → Change visibility; none contains secrets) and run the Deploy workflow again.

### By hand, on the server

```sh
kubectl -n gie get pods
kubectl -n gie logs deploy/core-api -f
kubectl top pods -n gie
kubectl -n gie rollout undo deployment/core-api   # back to the previous image
```

A rollback of core does not undo Flyway migrations: going back past a migration means the old code runs
against the new schema.

### Data

Everything that matters is on two volumes, and they belong together:

- `data-postgres-0`: users, balances, orders, trades, the ledger;
- `data-kafka-0`: the `orders` topic, from which the matcher rebuilds its order books at every start.

Losing only one of them leaves the other inconsistent: orders that core considers open but the matcher has
never seen, or the reverse. To start from scratch, drop both:

```sh
kubectl -n gie scale deployment --all --replicas=0
kubectl -n gie delete statefulset postgres kafka
kubectl -n gie delete pvc data-postgres-0 data-kafka-0
# then run the Deploy workflow, or kubectl apply -k /srv/game-item-exchange/k8s/overlays/prod
```

Old tokens stop working, even when their user id is taken again by someone new (core rejects a token
issued before its user was created): visitors find themselves signed out, and the bots sign in again
by themselves.

Kafka keeps `orders` forever, so its volume grows with the bots' activity (on the order of tens of megabytes
a day at one order per second), and so does the matcher's replay at startup. Snapshots of the order books
would bound both; until they exist, starting from scratch now and then is the way to reset.
