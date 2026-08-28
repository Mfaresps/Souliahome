#!/usr/bin/env bash
#
# SOULIA — استرجاع نسخة من السحابة
# ---------------------------------------------------------------------------
#   ./scripts/cloud-restore.sh                    # يعرض النسخ المتاحة
#   ./scripts/cloud-restore.sh <اسم-الملف>        # يسترجع نسخة محددة
#   ./scripts/cloud-restore.sh <اسم-الملف> --test # يسترجع إلى قاعدة تجريبية
#
# ⚠ بدون --test يُكتب فوق قاعدة البيانات الحيّة.
#
# «نسخة لم يجرّبها أحد ليست نسخة» — شغّل --test مرة شهرياً على الأقل.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/cloud-backup.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

MONGO_CONTAINER="${MONGO_CONTAINER:-soulia-mongodb}"
MONGO_USER="${MONGO_USER:-soulia}"
MONGO_PASS="${MONGO_PASS:-}"
MONGO_DB="${MONGO_DB:-soulia}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${BUCKET:-soulia-backups}"
PREFIX="${PREFIX:-mongo}"
WORK_DIR="${WORK_DIR:-/var/backups/soulia}"

REMOTE_PATH="$RCLONE_REMOTE:$BUCKET/$PREFIX"
FILE="${1:-}"
MODE="${2:-}"

[ -n "$MONGO_PASS" ] || { echo "❌ MONGO_PASS غير معرّف — راجع $ENV_FILE"; exit 1; }

# ── بدون وسيط: اعرض القائمة ────────────────────────────────────────────────
if [ -z "$FILE" ]; then
  echo "النسخ المتاحة على $REMOTE_PATH :"
  echo
  rclone lsl "$REMOTE_PATH/" --include 'soulia_*.archive.gz' 2>/dev/null \
    | sort -k4 -r \
    | awk '{printf "  %-38s  %8.2f MB   %s %s\n", $4, $1/1048576, $2, $3}'
  echo
  echo "للاسترجاع:            ./scripts/cloud-restore.sh <اسم-الملف>"
  echo "للتجربة الآمنة:       ./scripts/cloud-restore.sh <اسم-الملف> --test"
  exit 0
fi

# ── التنزيل ────────────────────────────────────────────────────────────────
mkdir -p "$WORK_DIR"
LOCAL="$WORK_DIR/$FILE"

if [ ! -f "$LOCAL" ]; then
  echo "⬇  تنزيل $FILE ..."
  rclone copy "$REMOTE_PATH/$FILE" "$WORK_DIR/" --progress \
    || { echo "❌ فشل التنزيل — تأكد من الاسم"; exit 1; }
fi
[ -f "$LOCAL" ] || { echo "❌ الملف غير موجود بعد التنزيل"; exit 1; }

echo "✔  الملف جاهز: $(du -h "$LOCAL" | cut -f1)"

# ── وضع التجربة: قاعدة منفصلة، لا تمسّ الحيّة ──────────────────────────────
if [ "$MODE" = "--test" ]; then
  TEST_DB="${MONGO_DB}_restore_test"
  echo
  echo "🧪 استرجاع تجريبي إلى قاعدة: $TEST_DB"
  echo "   قاعدة البيانات الحيّة ($MONGO_DB) لن تُمسّ."
  echo

  docker exec -i "$MONGO_CONTAINER" mongorestore \
      --username="$MONGO_USER" --password="$MONGO_PASS" \
      --authenticationDatabase=admin \
      --archive --gzip --drop \
      --nsFrom="$MONGO_DB.*" --nsTo="$TEST_DB.*" < "$LOCAL"

  echo
  echo "📊 عدد السجلات في القاعدة التجريبية:"
  docker exec "$MONGO_CONTAINER" mongosh \
      --quiet -u "$MONGO_USER" -p "$MONGO_PASS" --authenticationDatabase admin \
      --eval "db.getSiblingDB('$TEST_DB').getCollectionNames().sort().forEach(c => { const n = db.getSiblingDB('$TEST_DB')[c].countDocuments(); if (n > 0) print('   ' + c.padEnd(28) + n); })"

  echo
  echo "✅ نجحت التجربة — النسخة سليمة وقابلة للاسترجاع."
  echo "   لحذف القاعدة التجريبية:"
  echo "   docker exec $MONGO_CONTAINER mongosh -u $MONGO_USER -p '***' --authenticationDatabase admin --eval \"db.getSiblingDB('$TEST_DB').dropDatabase()\""
  exit 0
fi

# ── الاسترجاع الحقيقي ──────────────────────────────────────────────────────
echo
echo "⚠️  ═══════════════════════════════════════════════════"
echo "⚠️   سيُكتب فوق قاعدة البيانات الحيّة: $MONGO_DB"
echo "⚠️   كل البيانات الحالية ستُستبدل بمحتوى النسخة."
echo "⚠️  ═══════════════════════════════════════════════════"
echo
read -r -p "اكتب  YES  للمتابعة: " CONFIRM
[ "$CONFIRM" = "YES" ] || { echo "أُلغيت العملية."; exit 0; }

# نسخة أمان قبل الكتابة — لو تبيّن أن النسخة المسترجعة خاطئة، هذا هو طريق الرجوع.
SAFETY="$WORK_DIR/pre-restore_$(date -u '+%Y-%m-%dT%H-%M-%S').archive.gz"
echo "📦 حفظ نسخة أمان من الوضع الحالي..."
docker exec "$MONGO_CONTAINER" mongodump \
    --username="$MONGO_USER" --password="$MONGO_PASS" \
    --authenticationDatabase=admin --db="$MONGO_DB" \
    --archive --gzip > "$SAFETY"
echo "   $SAFETY"

echo "♻  جارٍ الاسترجاع..."
docker exec -i "$MONGO_CONTAINER" mongorestore \
    --username="$MONGO_USER" --password="$MONGO_PASS" \
    --authenticationDatabase=admin \
    --archive --gzip --drop < "$LOCAL"

echo
echo "✅ اكتمل الاسترجاع."
echo "   أعد تشغيل الواجهة الخلفية:  docker restart soulia-backend"
echo "   نسخة الأمان قبل الاسترجاع:  $SAFETY"
