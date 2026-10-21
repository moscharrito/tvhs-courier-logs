# Play Store feature graphic, 1024x500.
#
# Drawn rather than screenshotted: a feature graphic is a banner, not a
# capture, and nothing on the emulator can produce one. Colours are the
# app's own (app/src/theme.ts) so the listing and the product match.
#
# Play crops this on some surfaces and overlays an install button on
# others, so the safe area is the middle. Nothing load-bearing goes near
# an edge, and no text sits in the lower right.

Add-Type -AssemblyName System.Drawing

$W = 1024; $H = 500
$green       = [System.Drawing.ColorTranslator]::FromHtml('#14532d')
$greenBright = [System.Drawing.ColorTranslator]::FromHtml('#16a34a')
$greenSoft   = [System.Drawing.ColorTranslator]::FromHtml('#dcfce7')
$white       = [System.Drawing.Color]::White

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'ClearTypeGridFit'
$g.InterpolationMode = 'HighQualityBicubic'

# Background: a vertical lift from the brand green so it is not a flat slab.
$deep = [System.Drawing.ColorTranslator]::FromHtml('#0d3b20')
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0,0)),
    (New-Object System.Drawing.Point(0,$H)), $green, $deep)
$g.FillRectangle($brush, 0, 0, $W, $H)

# A route line across the lower third: the product is deliveries, and a
# literal van would be a stock-art cliche.
$pen = New-Object System.Drawing.Pen($greenBright, 5)
$pen.DashStyle = 'Dash'
$pts = @(
    (New-Object System.Drawing.Point(70,  410)),
    (New-Object System.Drawing.Point(250, 370)),
    (New-Object System.Drawing.Point(430, 415)),
    (New-Object System.Drawing.Point(620, 360)),
    (New-Object System.Drawing.Point(800, 400)),
    (New-Object System.Drawing.Point(960, 355))
)
$g.DrawCurve($pen, $pts, 0.5)
foreach ($p in $pts) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($greenSoft)), $p.X - 9, $p.Y - 9, 18, 18)
}

# The TAG roundel, left, matching the app's launcher mark.
$cx = 150; $cy = 200; $r = 96
$g.FillEllipse((New-Object System.Drawing.SolidBrush($greenBright)), $cx - $r, $cy - $r, $r*2, $r*2)
$fTag = New-Object System.Drawing.Font('Segoe UI', 54, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
# -ArgumentList, not a parenthesised list: New-Object Type(a,b,c,d) hands
# the whole list over as ONE array argument, and the constructor is never
# found. It fails loudly here; the rest of the image still draws, which is
# how a banner with no wordmark on it gets written.
$rect = New-Object System.Drawing.RectangleF -ArgumentList ([float]($cx - $r)), ([float]($cy - $r - 6)), ([float]($r*2)), ([float]($r*2))
$g.DrawString('TAG', $fTag, (New-Object System.Drawing.SolidBrush($white)), $rect, $fmt)

# Wordmark and the one line that says what it is.
$fName = New-Object System.Drawing.Font('Segoe UI', 44, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fSub  = New-Object System.Drawing.Font('Segoe UI', 21, [System.Drawing.FontStyle]::Regular, 'Pixel')
$fFoot = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Regular, 'Pixel')
$g.DrawString('Izy Courier', $fName, (New-Object System.Drawing.SolidBrush($white)), 300, 140)
$g.DrawString('Pharmacy deliveries, signed for and proven.', $fSub,
              (New-Object System.Drawing.SolidBrush($greenSoft)), 306, 215)
$g.DrawString('Izy Global Services LLC', $fFoot,
              (New-Object System.Drawing.SolidBrush($greenSoft)), 306, 262)

$g.Dispose()
$dest = Join-Path $PSScriptRoot 'feature-graphic-1024x500.png'
$bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"wrote $dest"
