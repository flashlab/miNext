#!/usr/bin/env bash
# 同步本地项目到部署目标(不含前端产物/数据/真实配置)
# 目标主机在 .env 的 MINEXT_DEPLOY_HOST 配置,如: user@your-host
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
: "${MINEXT_DEPLOY_HOST:?请在 .env 配置 MINEXT_DEPLOY_HOST=user@host}"
tar czf - \
  --exclude=node_modules --exclude=web/node_modules --exclude=web/dist \
  --exclude=data --exclude=ref --exclude='*.tar.gz' \
  --exclude=.env --exclude=minext.config.json \
  . | ssh -o BatchMode=yes "$MINEXT_DEPLOY_HOST" 'cd /opt/miNext && tar xzf -'
echo "✅ 已同步到 $MINEXT_DEPLOY_HOST:/opt/miNext"
