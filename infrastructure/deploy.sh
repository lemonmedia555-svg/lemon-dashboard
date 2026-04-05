#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════
# Lemon Dashboard — Deploy Script
# ═══════════════════════════════════════════
# Перед запуском:
# 1. Установите и авторизуйте yc CLI: curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
# 2. Выполните: yc init
# 3. Заполните переменные ниже

# ── Конфигурация ──
BUCKET_NAME="lemon-dashboard"
FUNCTION_NAME="lemon-dashboard-api"
GATEWAY_NAME="lemon-dashboard-gw"
SERVICE_ACCOUNT_NAME="lemon-dashboard-sa"

# AmoCRM credentials (заполнить перед деплоем!)
AMO_DOMAIN="YOUR_SUBDOMAIN.amocrm.ru"
AMO_ACCESS_TOKEN="YOUR_ACCESS_TOKEN"
AMO_REFRESH_TOKEN="YOUR_REFRESH_TOKEN"
AMO_CLIENT_ID="YOUR_CLIENT_ID"
AMO_CLIENT_SECRET="YOUR_CLIENT_SECRET"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== 1. Создание сервисного аккаунта ==="
SA_ID=$(yc iam service-account get --name "$SERVICE_ACCOUNT_NAME" --format json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null || true)
if [ -z "$SA_ID" ]; then
    SA_ID=$(yc iam service-account create --name "$SERVICE_ACCOUNT_NAME" --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
    echo "Создан сервисный аккаунт: $SA_ID"

    FOLDER_ID=$(yc config get folder-id)
    yc resource-manager folder add-access-binding --id "$FOLDER_ID" --role functions.functionInvoker --subject "serviceAccount:$SA_ID"
    yc resource-manager folder add-access-binding --id "$FOLDER_ID" --role storage.editor --subject "serviceAccount:$SA_ID"
    yc resource-manager folder add-access-binding --id "$FOLDER_ID" --role api-gateway.editor --subject "serviceAccount:$SA_ID"
else
    echo "Сервисный аккаунт уже существует: $SA_ID"
fi

echo "=== 2. Создание бакета Object Storage ==="
yc storage bucket create --name "$BUCKET_NAME" --default-storage-class standard --max-size 1073741824 2>/dev/null || echo "Бакет уже существует"
yc storage bucket update --name "$BUCKET_NAME" --website-settings='{"index": "index.html"}' 2>/dev/null || true

echo "=== 3. Деплой Cloud Function ==="
cd "$PROJECT_DIR/backend"
npm install --production

yc serverless function create --name "$FUNCTION_NAME" 2>/dev/null || echo "Функция уже существует"

FUNCTION_ID=$(yc serverless function get --name "$FUNCTION_NAME" --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

yc serverless function version create \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs18 \
    --entrypoint handler.handler \
    --memory 128m \
    --execution-timeout 10s \
    --source-path "$PROJECT_DIR/backend" \
    --environment "AMO_DOMAIN=$AMO_DOMAIN,AMO_ACCESS_TOKEN=$AMO_ACCESS_TOKEN,AMO_REFRESH_TOKEN=$AMO_REFRESH_TOKEN,AMO_CLIENT_ID=$AMO_CLIENT_ID,AMO_CLIENT_SECRET=$AMO_CLIENT_SECRET"

echo "Cloud Function ID: $FUNCTION_ID"

echo "=== 4. Создание API Gateway ==="
# Подставляем ID функции и сервисного аккаунта в спецификацию
SPEC_FILE="$PROJECT_DIR/infrastructure/api-gateway-spec.yaml"
TEMP_SPEC="/tmp/lemon-gw-spec.yaml"
sed "s/\${FUNCTION_ID}/$FUNCTION_ID/g; s/\${SERVICE_ACCOUNT_ID}/$SA_ID/g" "$SPEC_FILE" > "$TEMP_SPEC"

yc serverless api-gateway create --name "$GATEWAY_NAME" --spec "$TEMP_SPEC" 2>/dev/null || \
yc serverless api-gateway update --name "$GATEWAY_NAME" --spec "$TEMP_SPEC"

GW_DOMAIN=$(yc serverless api-gateway get --name "$GATEWAY_NAME" --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['domain'])")
API_URL="https://$GW_DOMAIN/api/dashboard"

echo "API URL: $API_URL"

echo "=== 5. Деплой Frontend ==="
# Подставляем URL API в index.html
FRONTEND_FILE="$PROJECT_DIR/frontend/index.html"
sed -i.bak "s|const API_URL = '.*'|const API_URL = '$API_URL'|" "$FRONTEND_FILE"
rm -f "${FRONTEND_FILE}.bak"

yc storage s3api put-object \
    --bucket "$BUCKET_NAME" \
    --key index.html \
    --body "$FRONTEND_FILE" \
    --content-type "text/html; charset=utf-8"

WIDGET_URL="https://$BUCKET_NAME.website.yandexcloud.net/index.html"

echo ""
echo "═══════════════════════════════════════════"
echo "Деплой завершён!"
echo "═══════════════════════════════════════════"
echo "API:    $API_URL"
echo "Виджет: $WIDGET_URL"
echo ""
echo "Добавьте виджет в AmoCRM:"
echo "  Рабочий стол → Редактировать → Добавить свой виджет"
echo "  URL: $WIDGET_URL"
echo "  Размер: ширина 6, высота 3"
echo "═══════════════════════════════════════════"
