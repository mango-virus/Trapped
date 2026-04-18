$port = 8765
if ($args[0]) { $port = [int]$args[0] }
$root = (Resolve-Path (Split-Path $MyInvocation.MyCommand.Path)).Path
$prefix = "http://localhost:$port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "Failed to start on $prefix : $_"
  exit 1
}
Write-Host "Serving $root at $prefix"

$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
  '.js'='application/javascript; charset=utf-8'; '.mjs'='application/javascript; charset=utf-8'
  '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8'
  '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'
  '.gif'='image/gif'; '.ico'='image/x-icon'; '.webp'='image/webp'
  '.woff'='font/woff'; '.woff2'='font/woff2'; '.ttf'='font/ttf'
  '.wasm'='application/wasm'; '.map'='application/json'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $root ($path.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar))
    if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $ctype = $mime[$ext]; if (-not $ctype) { $ctype = 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($file)
      $res.ContentType = $ctype
      $res.ContentLength64 = $bytes.Length
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $body = [Text.Encoding]::UTF8.GetBytes("404: $path")
      $res.OutputStream.Write($body, 0, $body.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
