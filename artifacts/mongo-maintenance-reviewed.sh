#!/bin/sh
set -eu
set +x
umask 077
cd /opt/Souliahome

BASE=/opt/Souliahome/docker-compose.yml
OVERRIDE=/opt/Souliahome/docker-compose.override.yml
PROJECT=souliahome
DATA_VOLUME=souliahome_mongo-data
BACKUP_ROOT="${JENKINS_HOME:?JENKINS_HOME is required}/soulia-maintenance-backups"
BACKUP="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${BUILD_NUMBER:?}"
KEY=/data/db/.soulia-replica-key
APPLY_MAINTENANCE=1
APPS_STOPPED=0
DB_TOUCHED=0
OVERRIDE_WRITTEN=0
STEP='initial preflight'
PREFLIGHT_FAILED=0

check() {
  label=$1
  shift
  if "$@"; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    PREFLIGHT_FAILED=1
  fi
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    echo "FAILED STEP: $STEP"
    set +e
    if [ "$APPS_STOPPED" = 0 ] && [ "$DB_TOUCHED" = 0 ]; then
      echo 'Application containers and database configuration were not changed.'
    else
      echo 'Attempting to restore the previous standalone configuration.'
    fi
    if [ "$OVERRIDE_WRITTEN" = 1 ]; then
      mv "$OVERRIDE" "$BACKUP/failed-replica-override.yml"
      cp "$BACKUP/docker-compose.override.original.yml" "$OVERRIDE"
      chmod 600 "$OVERRIDE"
    fi
    if [ "$DB_TOUCHED" = 1 ]; then
      docker compose -p "$PROJECT" -f "$BASE" -f "$OVERRIDE" up -d --no-deps --pull never mongodb
      sleep 5
    fi
    if [ "$APPS_STOPPED" = 1 ]; then docker start soulia-backend soulia-frontend; fi
    if [ -s "$BACKUP/mongo.archive.gz" ] || [ -s "$BACKUP/mongo-volume.tar.gz" ]; then
      echo "Backup files present (review integrity results above): $BACKUP"
    else
      echo 'No database backup archives were created by this run.'
    fi
    echo 'Do not run another deployment until the result has been reviewed.'
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' HUP INT TERM

# Preserve the inspected server override; only add the MongoDB replica command.
check 'Base Compose file exists' test -f "$BASE"
check 'Existing server override is present' test -f "$OVERRIDE"
check 'Existing override is a regular file rather than a symlink' test ! -L "$OVERRIDE"
check 'Existing server override is writable' test -w "$OVERRIDE"
check 'Compose directory is writable' test -w /opt/Souliahome
check 'MongoDB belongs to expected Compose project' test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' soulia-mongodb)" = "$PROJECT"
check 'MongoDB uses expected persistent data volume' test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}{{end}}{{end}}' soulia-mongodb)" = "$DATA_VOLUME"
check 'Backend is running' test "$(docker inspect -f '{{.State.Running}}' soulia-backend)" = true
check 'Frontend is running' test "$(docker inspect -f '{{.State.Running}}' soulia-frontend)" = true
MONGO_IMAGE=$(docker inspect -f '{{.Image}}' soulia-mongodb)
check 'Local mongo:7 tag matches the running MongoDB image' test "$(docker image inspect -f '{{.Id}}' mongo:7)" = "$MONGO_IMAGE"
BACKEND_IMAGE=$(docker inspect -f '{{.Image}}' soulia-backend)
NETWORK=$(docker inspect -f '{{range $name, $settings := .NetworkSettings.Networks}}{{println $name}}{{end}}' soulia-backend)
NETWORK_COUNT=$(printf '%s
' "$NETWORK" | awk 'NF {n++} END {print n+0}')
echo "Backend networks ($NETWORK_COUNT): $NETWORK"
check 'Exactly one backend network is available for maintenance' test "$NETWORK_COUNT" -eq 1
check 'Current Compose configuration is valid' docker compose -p "$PROJECT" -f "$BASE" -f "$OVERRIDE" config --quiet
check 'MongoDB dump utility exists' docker exec soulia-mongodb sh -c 'command -v mongodump >/dev/null'
check 'MongoDB key generator exists' docker exec soulia-mongodb sh -c 'command -v openssl >/dev/null'
check 'MongoDB operating-system user exists' docker exec soulia-mongodb sh -c 'id mongodb >/dev/null'
check 'No pre-existing replica key to overwrite' docker exec soulia-mongodb test ! -e "$KEY"
check 'Host gzip exists' command -v gzip
check 'Host checksum utility exists' command -v sha256sum
if [ "$PREFLIGHT_FAILED" != 0 ]; then
  echo 'Preflight blocked. Send the FAIL lines; no application stop or MongoDB conversion was attempted.'
  exit 1
fi
STEP='prepare protected backup directory'
mkdir -p "$BACKUP"
chmod 700 "$BACKUP_ROOT" "$BACKUP"
cp "$BASE" "$BACKUP/docker-compose.original.yml"
cp "$OVERRIDE" "$BACKUP/docker-compose.override.original.yml"
sha256sum "$OVERRIDE" > "$BACKUP/override-original.sha256"
STEP='capture database connection without printing credentials'
docker inspect soulia-backend | docker exec -i soulia-backend node -e 'let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const entry=JSON.parse(input)[0].Config.Env.find(v=>v.startsWith("MONGODB_URI="));if(!entry||/[\r\n]/.test(entry))process.exit(1);process.stdout.write(entry+"\n");});' > "$BACKUP/backend-database.env"
test -s "$BACKUP/backend-database.env"

STEP='prepare a minimal replica change while preserving server settings'
docker compose -p "$PROJECT" -f "$BASE" -f "$OVERRIDE" config --format json > "$BACKUP/compose.before.json"
cat "$OVERRIDE" | docker exec -i soulia-backend node -e '
try {
  const fs = require("fs");
  const source = fs.readFileSync(0, "utf8");
  const lines = source.split(String.fromCharCode(10));
  const services = lines.findIndex(line => /^services:[ ]*(#.*)?$/.test(line));
  if (services < 0) throw Error();
  let end = services + 1;
  while (end < lines.length && !/^[^ #]/.test(lines[end])) end++;
  const section = lines.slice(services + 1, end);
  const indents = section.filter(line => /^[ ]+[^ #]/.test(line)).map(line => line.length - line.trimStart().length);
  if (!indents.length) throw Error();
  const serviceIndent = Math.min(...indents);
  const found = [];
  for (let index = services + 1; index < end; index++) {
    const match = lines[index].match(/^([ ]+)mongodb:[ ]*(#.*)?$/);
    if (match && match[1].length === serviceIndent) found.push({ index, indent: match[1] });
  }
  if (found.length !== 1) throw Error();
  const command = ["mongod", "--bind_ip_all", "--auth", "--replSet", "soulia-rs", "--keyFile", "/data/db/.soulia-replica-key"];
  lines.splice(found[0].index + 1, 0, found[0].indent + "  command: " + JSON.stringify(command));
  process.stdout.write(lines.join(String.fromCharCode(10)));
} catch (_) { console.error("The existing override structure cannot be patched automatically. No live configuration was changed."); process.exitCode = 1; }
' > "$BACKUP/replica-override.candidate.yml"
docker compose -p "$PROJECT" -f "$BASE" -f "$BACKUP/replica-override.candidate.yml" config --format json > "$BACKUP/compose.after.json"
{
  cat "$BACKUP/compose.before.json"
  printf '\0'
  cat "$BACKUP/compose.after.json"
} | docker exec -i soulia-backend node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const configs = input.split(String.fromCharCode(0)).map(JSON.parse);
    if (configs.length !== 2) throw Error();
    const [before, after] = configs;
    const same = require("util").isDeepStrictEqual;
    const expected = ["mongod", "--bind_ip_all", "--auth", "--replSet", "soulia-rs", "--keyFile", "/data/db/.soulia-replica-key"];
    if (!before.services.mongodb || before.services.mongodb.command != null || before.services.mongodb.entrypoint != null || before.services.mongodb.image !== "mongo:7") throw Error();
    if (!same(after.services.mongodb.command, expected)) throw Error();
    delete after.services.mongodb.command;
    delete before.services.mongodb.command;
    if (!same(before, after)) throw Error();
    console.log("PASS: only the MongoDB replica command changes; all ports, localhost bindings, environments, mounts and other service settings match exactly.");
  } catch (_) { console.error("Server settings comparison failed. No live configuration was changed; configuration values were not printed."); process.exitCode = 1; }
});'

# Verify authenticated access without printing credentials; refuse an existing replica set.
STEP='authenticated standalone database check'
docker exec -i soulia-mongodb mongosh --quiet --nodb <<'JS'
try {
  if (!process.env.MONGO_INITDB_ROOT_USERNAME || !process.env.MONGO_INITDB_ROOT_PASSWORD) throw Error();
  const conn = new Mongo('mongodb://127.0.0.1:27017/admin?directConnection=true');
  const admin = conn.getDB('admin');
  if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) throw Error();
  const hello = admin.runCommand({ hello: 1 });
  if (!hello.ok || hello.setName || hello.msg === 'isdbgrid') throw Error();
  print('Authenticated standalone confirmed.');
} catch (_) { print('Preflight failed; verify existing MongoDB topology and credentials.'); quit(1); }
JS

# Reserve space for a dump and a separate cold filesystem backup, plus headroom.
STEP='backup disk capacity check'
DATA_KB=$(docker exec soulia-mongodb sh -c 'du -sk /data/db | cut -f1')
FREE_KB=$(df -Pk "$BACKUP" | awk 'NR==2 {print $4}')
echo "Database size KB: $DATA_KB; backup free space KB: $FREE_KB; required KB: $((DATA_KB * 3 + 1048576))"
test "$FREE_KB" -gt "$((DATA_KB * 3 + 1048576))"

if [ "$APPLY_MAINTENANCE" != 1 ]; then
  echo 'PREFLIGHT PASSED. Diagnostic mode only: application remains running; no backup archives, database conversion or indexes were created.'
  exit 0
fi

STEP='stop application containers'
sha256sum -c "$BACKUP/override-original.sha256"
echo 'Stopping application writes for the maintenance window.'
APPS_STOPPED=1
docker stop -t 60 soulia-frontend soulia-backend

STEP='full logical database backup'
echo 'Taking a full authenticated logical backup.'
docker exec soulia-mongodb sh -c 'exec mongodump --quiet --host 127.0.0.1 --port 27017 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' > "$BACKUP/mongo.archive.gz"
test -s "$BACKUP/mongo.archive.gz"
gzip -t "$BACKUP/mongo.archive.gz"

STEP='cold database volume backup'
echo 'Taking a cold copy of the existing database volume.'
DB_TOUCHED=1
docker stop -t 120 soulia-mongodb
docker run --rm --network none --entrypoint sh --mount "type=volume,src=$DATA_VOLUME,dst=/source,readonly" "$MONGO_IMAGE" -c 'cd /source && tar -czf - .' > "$BACKUP/mongo-volume.tar.gz"
test -s "$BACKUP/mongo-volume.tar.gz"
gzip -t "$BACKUP/mongo-volume.tar.gz"
sha256sum "$BACKUP/mongo.archive.gz" "$BACKUP/mongo-volume.tar.gz" > "$BACKUP/SHA256SUMS"
echo "Both backup archives passed compression integrity checks. Location: $BACKUP"

# Add the internal membership key to the same persistent volume; never print it.
STEP='create internal membership key'
docker run --rm --network none --entrypoint sh --mount "type=volume,src=$DATA_VOLUME,dst=/source" "$MONGO_IMAGE" -c 'set -eu; test ! -e /source/.soulia-replica-key; umask 077; openssl rand -base64 756 > /source/.soulia-replica-key; chown mongodb:mongodb /source/.soulia-replica-key; chmod 400 /source/.soulia-replica-key'

# Apply the already checked minimal edit; retain all existing server overrides.
sha256sum -c "$BACKUP/override-original.sha256"
OVERRIDE_WRITTEN=1
STEP='replica Compose configuration'
cp "$BACKUP/replica-override.candidate.yml" "$OVERRIDE"
chmod 600 "$OVERRIDE"
docker compose -p "$PROJECT" config --quiet
docker compose -p "$PROJECT" up -d --no-deps --pull never mongodb
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}{{end}}{{end}}' soulia-mongodb)" = "$DATA_VOLUME"

STEP='replica initialization and primary election'
echo 'Initializing the single-member replica set and waiting for primary.'
docker exec -i soulia-mongodb mongosh --quiet --nodb <<'JS'
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const conn = new Mongo('mongodb://127.0.0.1:27017/admin?directConnection=true');
    const admin = conn.getDB('admin');
    if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) throw Error();
    const hello = admin.runCommand({ hello: 1 });
    if (hello.setName && hello.setName !== 'soulia-rs') throw Error();
    if (!hello.setName) {
      const init = admin.runCommand({ replSetInitiate: { _id: 'soulia-rs', members: [{ _id: 0, host: 'mongodb:27017' }] } });
      if (!init.ok && init.codeName !== 'AlreadyInitialized') throw Error();
    }
    const current = admin.runCommand({ hello: 1 });
    if (current.setName === 'soulia-rs' && current.isWritablePrimary) { ready = true; break; }
  } catch (_) { /* Startup/election may still be in progress. Never print credentials. */ }
  sleep(1000);
}
if (!ready) { print('Replica primary was not ready within 60 seconds.'); quit(1); }
print('Replica primary ready; authentication remains enabled.');
JS

# Use the currently deployed backend image/env in a temporary container. Starting Nest
# would run application schedules, so invoke only the migration module through Node.
STEP='tracking index migration and transaction verification'
echo 'Creating only the required tracking indexes and checking a read transaction.'
docker run --rm -i --network "$NETWORK" --env-file "$BACKUP/backend-database.env" --entrypoint node "$BACKEND_IMAGE" - <<'JS'
const mongoose = require('mongoose');
const { migrateInventoryUnitIndexes } = require('./dist/inventory-units/inventory-unit-index.migration.js');
const { inspect } = require('./scripts/check-inventory-readiness.cjs');
(async () => {
  const connection = mongoose.createConnection(process.env.MONGODB_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  try {
    await connection.asPromise();
    const hello = await connection.db.admin().command({ hello: 1 });
    if (hello.setName !== 'soulia-rs' || !hello.isWritablePrimary) throw Error();
    await migrateInventoryUnitIndexes(connection.db, true);
    const readiness = await inspect(connection, migrateInventoryUnitIndexes);
    if (!readiness.writesReady) throw Error();
    const session = await connection.startSession();
    try { await session.withTransaction(async () => { await connection.db.collection('settings').findOne({}, { session, projection: { _id: 1 } }); }); }
    finally { await session.endSession(); }
    console.log(JSON.stringify({ writesReady: true, transactionsSupported: true, trackingIndexesReady: true }));
  } finally { await connection.close(); }
})().catch(() => { console.error('Tracking preparation failed; inspect index conflicts or connection settings.'); process.exitCode = 1; });
JS

STEP='application restart and final readiness'
echo 'Starting the original application containers.'
docker start soulia-backend soulia-frontend
healthy=0
for attempt in $(seq 1 60); do
  if docker exec soulia-backend node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
test "$healthy" = 1
docker exec soulia-backend node scripts/check-inventory-readiness.cjs
APPS_STOPPED=0
DB_TOUCHED=0
trap - EXIT HUP INT TERM
echo 'SUCCESS: inventory database prepared. No purchase receipts, stock quantities or financial entries were created by this job.'
echo "Keep both backup archives in: $BACKUP"
