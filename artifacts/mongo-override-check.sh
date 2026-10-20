#!/bin/sh
set -eu
set +x
cd /opt/Souliahome
docker compose -p souliahome -f docker-compose.yml -f docker-compose.override.yml config --format json | docker exec -i soulia-backend node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const config = JSON.parse(input);
    const report = { services: {}, volumes: {}, networks: Object.keys(config.networks || {}) };
    for (const [name, service] of Object.entries(config.services || {})) {
      const args = Array.isArray(service.command) ? service.command : [];
      const mongoFlags = {};
      for (const flag of ["--replSet", "--keyFile", "--config", "--dbpath"]) {
        const index = args.indexOf(flag);
        if (index >= 0) mongoFlags[flag] = args[index + 1] || "missing-value";
      }
      report.services[name] = {
        containerName: service.container_name,
        ports: (service.ports || []).map(p => typeof p === "object" ? { published: p.published, target: p.target, hostIp: p.host_ip } : p),
        volumes: (service.volumes || []).map(v => typeof v === "object" ? { type: v.type, source: v.source, target: v.target, readOnly: v.read_only } : v),
        networks: Object.keys(service.networks || {}),
        commandConfigured: service.command != null,
        customCommandString: typeof service.command === "string",
        entrypointConfigured: service.entrypoint != null,
        ...(name === "mongodb" ? { mongoFlags, authFlag: args.includes("--auth") } : {}),
        environmentKeys: Object.keys(service.environment || {})
      };
    }
    for (const [key, volume] of Object.entries(config.volumes || {})) report.volumes[key] = { name: volume.name, external: volume.external || false };
    console.log(JSON.stringify(report, null, 2));
  } catch (_) { console.error("Unable to inspect Compose configuration; configuration values were not printed."); process.exitCode = 1; }
});'
