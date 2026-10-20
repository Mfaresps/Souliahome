$ErrorActionPreference = 'Stop'
# Local development only. No service installation, data copying, initialization or migrations.
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'backend\.local-mongodb\mongod.cfg'
$binaryPath = 'C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Approved local replica configuration is missing.' }
if (-not (Test-Path -LiteralPath $binaryPath)) { throw 'MongoDB server executable is missing.' }
$probe = New-Object System.Net.Sockets.TcpClient
$occupied = $false
try { $probe.Connect('127.0.0.1', 27018); $occupied = $true } catch { } finally { $probe.Dispose() }
if (-not $occupied) {
    $runtimePath = Split-Path -Parent $configPath
    Start-Process -FilePath $binaryPath -ArgumentList @('--config', ('"' + $configPath + '"')) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'startup.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'startup.stderr.log') | Out-Null
}
$previousDirectory = Get-Location
try {
    Set-Location -LiteralPath $projectRoot
    @'
const {MongoClient}=require('./backend/node_modules/mongodb');
(async()=>{
 const c=await MongoClient.connect('mongodb://127.0.0.1:27018/soulia?replicaSet=souliaDev',{serverSelectionTimeoutMS:20000});
 try { const h=await c.db().admin().command({hello:1});
  if(h.setName!=='souliaDev'||!h.isWritablePrimary)throw Error('Unexpected local database');
  console.log('Local development replica set is ready on 127.0.0.1:27018.');
 } finally {await c.close();}
})().catch(()=>{console.error('Local replica startup/verification failed. Inspect private runtime logs.');process.exitCode=1;});
'@ | node
    if ($LASTEXITCODE -ne 0) { throw 'Local MongoDB readiness failed; backend was not started.' }
} finally { Set-Location -LiteralPath $previousDirectory }
