# YT-TLDW log sink (PowerShell fallback)
$ErrorActionPreference = 'Stop'
$HostAddr = '127.0.0.1'
$Port = 47321
$LogDir = 'C:\Users\user1\yt-tldw\logs'
$LogFile = Join-Path $LogDir 'tldw.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://$HostAddr`:$Port/")
$listener.Start()
Add-Content -Path $LogFile -Value (@{t=(Get-Date).ToString('o'); event='logserver-start'; port=$Port; file=$LogFile} | ConvertTo-Json -Compress)
Write-Host "YT-TLDW logserver on http://$HostAddr`:$Port/log -> $LogFile"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  $res.Headers.Add('Access-Control-Allow-Origin', '*')
  try {
    if ($req.HttpMethod -eq 'OPTIONS') { $res.StatusCode = 204; $res.Close(); continue }
    if ($req.HttpMethod -eq 'GET') {
      $bytes = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
      $res.ContentType = 'application/json'; $res.OutputStream.Write($bytes,0,$bytes.Length); $res.Close(); continue
    }
    if ($req.HttpMethod -eq 'POST') {
      $reader = New-Object IO.StreamReader($req.InputStream)
      $body = $reader.ReadToEnd()
      $reader.Close()
      try {
        $payload = $body | ConvertFrom-Json
        if ($payload.lines) { foreach ($line in $payload.lines) { Add-Content -Path $LogFile -Value (($line | ConvertTo-Json -Compress -Depth 8)) } }
        elseif ($payload -is [System.Array]) { foreach ($line in $payload) { Add-Content -Path $LogFile -Value (($line | ConvertTo-Json -Compress -Depth 8)) } }
        else { Add-Content -Path $LogFile -Value (($payload | ConvertTo-Json -Compress -Depth 8)) }
      } catch { Add-Content -Path $LogFile -Value $body }
      $bytes = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
      $res.ContentType = 'application/json'; $res.StatusCode = 200
      $res.OutputStream.Write($bytes,0,$bytes.Length); $res.Close(); continue
    }
    $res.StatusCode = 404; $res.Close()
  } catch { try { $res.StatusCode = 500; $res.Close() } catch {} }
}
