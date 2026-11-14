# Builds "Centro de Comando.exe" and "Assistente.exe" into the project folder using the C# compiler that ships with Windows.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe não encontrado em $csc" }

# Icon: dark disc, accent ring, green status dot (same palette as the UI). PNG-in-ICO, 256px.
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $here 'icon.ico'
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#111419'))), 8, 8, 240, 240)
$g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#6ea8fe')), 14), 22, 22, 212, 212)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#5ccf95'))), 98, 98, 60, 60)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$w = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($ico))
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # header: reserved, type=icon, count
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0) # 256x256, no palette
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png); $w.Close()

$common = @('/nologo', '/target:winexe', '/optimize+', '/codepage:65001', "/win32icon:$ico",
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
$src = Join-Path $here 'launcher.cs'
& $csc @common "/out:$(Join-Path $root 'Centro de Comando.exe')" $src
if ($LASTEXITCODE) { throw 'falha ao compilar Centro de Comando.exe' }
& $csc @common '/define:VOZ' "/out:$(Join-Path $root 'Assistente.exe')" $src
if ($LASTEXITCODE) { throw 'falha ao compilar Assistente.exe' }
'ok'
