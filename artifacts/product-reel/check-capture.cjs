const fs=require('fs'),path=require('path');const root=__dirname;
const a=JSON.parse(fs.readFileSync(path.join(root,'capture-audit.json')));
if(a.errors.length)throw Error(a.errors.join('\n'));
console.log(JSON.stringify({captureErrors:a.errors.length,localAssets:a.local,blockedRequests:a.blocked,shots:a.shots.length}));
