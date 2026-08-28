#!/usr/bin/env bash
#
# SOULIA — النسخ الاحتياطي السحابي اليومي
# ---------------------------------------------------------------------------
# يعمل نسخة جديدة، يضغطها، يرفعها إلى Cloudflare R2، ويبقي آخر N نسخة فقط.
#
#   التشغيل:   ./scripts/cloud-backup.sh
#   تجربة:     DRY_RUN=1 ./scripts/cloud-backup.sh
#
# الإعداد في scripts/cloud-backup.env (انظر cloud-backup.env.example).
# المفاتيح نفسها ليست هنا ولا في هذا الملف — هي في ~/.config/rclone/rclone.conf
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/cloud-backup.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

# ── الإعدادات (يمكن تجاوزها من cloud-backup.env أو من البيئة) ──────────────
MONGO_CONTAINER="${MONGO_CONTAINER:-soulia-mongodb}"
MONGO_USER="${MONGO_USER:-soulia}"
MONGO_PASS="${MONGO_PASS:-}"
MONGO_DB="${MONGO_DB:-soulia}"

RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${BUCKET:-soulia-backups}"
PREFIX="${PREFIX:-mongo}"

KEEP="${KEEP:-14}"                       # عدد النسخ التي تبقى على السحابة
LOCAL_KEEP="${LOCAL_KEEP:-3}"            # عدد النسخ التي تبقى محلياً
WORK_DIR="${WORK_DIR:-/var/backups/soulia}"
LOG_FILE="${LOG_FILE:-$WORK_DIR/cloud-backup.log}"
STATE_FILE="${STATE_FILE:-$WORK_DIR/last-run.json}"
DRY_RUN="${DRY_RUN:-0}"

REMOTE_PATH="$RCLONE_REMOTE:$BUCKET/$PREFIX"

# ── أدوات ──────────────────────────────────────────────────────────────────
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
die() { log "❌ $*"; write_state "error" "$*"; exit 1; }

# تهريب نص ليصلح كقيمة JSON. رسائل الأخطاء تحتوي أحياناً على " أو \
# (مسارات، مخرجات mongodump)، وقيمة غير مهرَّبة تنتج ملف حالة تالفاً
# فتعرض اللوحة "تعذّر القراءة" بدل الخطأ الحقيقي.
json_escape() {
  printf '%s' "$1" | awk '{
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); printf "%s", $0
  }'
}

# عدّ أسطر غير فارغة — grep -c . يعيد سطرين على مدخل فارغ في بعض البيئات.
count_lines() { printf '%s' "$1" | grep -c '[^[:space:]]' 2>/dev/null || true; }

# يكتب نتيجة آخر تشغيل — هذا الملف هو ما تقرأه لوحة الإعدادات.
# يُكتب في كل الحالات (نجاح أو فشل)، لأن "فشل صامت" هو ما نحاول منعه أصلاً.
write_state() {
  local status="$1" message="${2:-}" file="${3:-}" size="${4:-0}" count="${5:-0}"
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" <<EOF
{
  "status": "$status",
  "message": "$(json_escape "$message")",
  "file": "$(json_escape "$file")",
  "sizeBytes": ${size:-0},
  "remoteCount": ${count:-0},
  "keep": $KEEP,
  "finishedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
}

run() { if [ "$DRY_RUN" = "1" ]; then log "   [تجربة] $*"; else "$@"; fi; }

# ── فحوصات مسبقة ───────────────────────────────────────────────────────────
mkdir -p "$WORK_DIR"
command -v rclone >/dev/null 2>&1 || die "rclone غير مثبّت"
command -v docker >/dev/null 2>&1 || die "docker غير موجود"
[ -n "$MONGO_PASS" ] || die "MONGO_PASS غير معرّف — راجع $ENV_FILE"

rclone lsd "$RCLONE_REMOTE:" >/dev/null 2>&1 \
  || die "تعذّر الاتصال بـ $RCLONE_REMOTE — شغّل: rclone config"

log "──────── بدء النسخ الاحتياطي ────────"
[ "$DRY_RUN" = "1" ] && log "⚠ وضع التجربة — لن يُرفع أو يُحذف شيء"

# ── ١. إنشاء النسخة ────────────────────────────────────────────────────────
STAMP="$(date -u '+%Y-%m-%dT%H-%M-%S')"
ARCHIVE="$WORK_DIR/soulia_${STAMP}.archive.gz"

log "١/٤  إنشاء نسخة من قاعدة البيانات..."
# --archive + --gzip: ملف واحد مضغوط. القياس على بيانات هذا النظام: ضغط ٩١٪.
if ! docker exec "$MONGO_CONTAINER" mongodump \
        --username="$MONGO_USER" --password="$MONGO_PASS" \
        --authenticationDatabase=admin --db="$MONGO_DB" \
        --archive --gzip > "$ARCHIVE" 2>>"$LOG_FILE"; then
  rm -f "$ARCHIVE"
  die "فشل mongodump — راجع $LOG_FILE"
fi

# ملف بحجم تافه يعني dump فاشل. الرفع هنا يستهلك نسخة من الـ ١٤ ويطرد نسخة سليمة.
SIZE=$(stat -c%s "$ARCHIVE" 2>/dev/null || stat -f%z "$ARCHIVE")
if [ "$SIZE" -lt 10240 ]; then
  rm -f "$ARCHIVE"
  die "النسخة الناتجة صغيرة بشكل غير طبيعي ($SIZE بايت) — يُرجّح فشل الاتصال بقاعدة البيانات"
fi
log "     تم — $(numfmt --to=iec-i --suffix=B "$SIZE" 2>/dev/null || echo "$SIZE bytes")"

# ── ٢. الرفع ───────────────────────────────────────────────────────────────
log "٢/٤  الرفع إلى $REMOTE_PATH ..."
if [ "$DRY_RUN" != "1" ]; then
  rclone copy "$ARCHIVE" "$REMOTE_PATH/" \
      --s3-no-check-bucket --retries 3 --low-level-retries 10 \
      --stats-one-line --stats 0 2>>"$LOG_FILE" \
    || die "فشل الرفع — لم يُحذف أي شيء"

  # تأكيد وجود الملف فعلياً بعد الرفع — "نجح الأمر" ليس دليلاً كافياً.
  rclone lsf "$REMOTE_PATH/$(basename "$ARCHIVE")" >/dev/null 2>&1 \
    || die "الملف غير موجود على السحابة بعد الرفع"
else
  log "   [تجربة] rclone copy $ARCHIVE $REMOTE_PATH/"
fi
log "     تم الرفع والتأكد منه"

# ── ٣. التنظيف على السحابة — يبقي آخر KEEP نسخة ────────────────────────────
# بالعدد وليس بالعمر: --min-age يمحو كل شيء لو توقّف النسخ عن العمل أياماً،
# و rclone sync يمحو السحابة لو فرغ المجلد المحلي. الترتيب هنا أبجدي وهو
# نفسه الترتيب الزمني لأن الطابع الزمني ISO داخل الاسم.
log "٣/٤  التنظيف — الإبقاء على آخر $KEEP نسخة..."
REMOTE_LIST=$(rclone lsf "$REMOTE_PATH/" --files-only --include 'soulia_*.archive.gz' 2>/dev/null | sort -r || true)
TOTAL=$(count_lines "$REMOTE_LIST")
TOTAL=${TOTAL:-0}

if [ "$TOTAL" -le "$KEEP" ]; then
  log "     العدد الحالي $TOTAL — لا حذف (الحد $KEEP)"
else
  printf '%s\n' "$REMOTE_LIST" | tail -n +$((KEEP + 1)) | while read -r f; do
    [ -z "$f" ] && continue
    run rclone deletefile "$REMOTE_PATH/$f"
    log "     حُذف: $f"
  done
fi

# ── ٤. التنظيف المحلي ──────────────────────────────────────────────────────
log "٤/٤  تنظيف النسخ المحلية — الإبقاء على آخر $LOCAL_KEEP..."
ls -1 "$WORK_DIR"/soulia_*.archive.gz 2>/dev/null | sort -r | tail -n +$((LOCAL_KEEP + 1)) | while read -r f; do
  [ -z "$f" ] && continue
  run rm -f "$f"
  log "     حُذف محلياً: $(basename "$f")"
done

FINAL_COUNT=$(count_lines "$(rclone lsf "$REMOTE_PATH/" --files-only --include 'soulia_*.archive.gz' 2>/dev/null || true)")
FINAL_COUNT=${FINAL_COUNT:-0}
write_state "ok" "تم الرفع بنجاح" "$(basename "$ARCHIVE")" "$SIZE" "$FINAL_COUNT"
log "✅ اكتمل — $FINAL_COUNT نسخة على السحابة"
log ""
