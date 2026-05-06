Add-Type -AssemblyName System.Drawing

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$iconDir = Join-Path $root "src\extension\icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-Point([float] $x, [float] $y, [float] $scale) {
  return [System.Drawing.PointF]::new($x * $scale, $y * $scale)
}

foreach ($size in 16, 32, 48, 128) {
  $scale = [float] ($size / 128.0)
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $rect = [System.Drawing.RectangleF]::new(8 * $scale, 8 * $scale, 112 * $scale, 112 * $scale)
  $radius = [Math]::Max(3, 25 * $scale)
  $diameter = $radius * 2
  $backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $backgroundPath.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $backgroundPath.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $backgroundPath.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $backgroundPath.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $backgroundPath.CloseFigure()
  $backgroundBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 253, 249, 250),
    [System.Drawing.Color]::FromArgb(255, 168, 221, 217),
    45
  )
  $graphics.FillPath($backgroundBrush, $backgroundPath)

  $gemPoints = [System.Drawing.PointF[]] @(
    (New-Point 64 16 $scale),
    (New-Point 104 39.5 $scale),
    (New-Point 104 88.5 $scale),
    (New-Point 64 112 $scale),
    (New-Point 24 88.5 $scale),
    (New-Point 24 39.5 $scale)
  )
  $gemRect = [System.Drawing.RectangleF]::new(24 * $scale, 16 * $scale, 80 * $scale, 96 * $scale)
  $gemBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $gemRect,
    [System.Drawing.Color]::FromArgb(255, 240, 208, 212),
    [System.Drawing.Color]::FromArgb(255, 93, 188, 180),
    60
  )
  $graphics.FillPolygon($gemBrush, $gemPoints)

  $topBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(210, 240, 208, 212))
  $leftBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(215, 212, 144, 154))
  $rightBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(230, 93, 188, 180))
  $graphics.FillPolygon($topBrush, [System.Drawing.PointF[]] @(
    (New-Point 64 16 $scale),
    (New-Point 104 39.5 $scale),
    (New-Point 64 56 $scale),
    (New-Point 24 39.5 $scale)
  ))
  $graphics.FillPolygon($leftBrush, [System.Drawing.PointF[]] @(
    (New-Point 24 39.5 $scale),
    (New-Point 64 56 $scale),
    (New-Point 64 112 $scale),
    (New-Point 24 88.5 $scale)
  ))
  $graphics.FillPolygon($rightBrush, [System.Drawing.PointF[]] @(
    (New-Point 104 39.5 $scale),
    (New-Point 64 56 $scale),
    (New-Point 64 112 $scale),
    (New-Point 104 88.5 $scale)
  ))

  if ($size -ge 32) {
    $facetPen = [System.Drawing.Pen]::new(
      [System.Drawing.Color]::FromArgb(92, 255, 255, 255),
      [Math]::Max(1.4, 5 * $scale)
    )
    $facetPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $facetPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $facetPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawLine($facetPen, (New-Point 64 16 $scale), (New-Point 64 56 $scale))
    $graphics.DrawLine($facetPen, (New-Point 24 39.5 $scale), (New-Point 64 112 $scale))
    $graphics.DrawLine($facetPen, (New-Point 104 39.5 $scale), (New-Point 64 112 $scale))
    $graphics.DrawLine($facetPen, (New-Point 24 88.5 $scale), (New-Point 64 56 $scale))
    $graphics.DrawLine($facetPen, (New-Point 104 88.5 $scale), (New-Point 64 56 $scale))
    $facetPen.Dispose()
  }

  $shineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(96, 255, 255, 255))
  $graphics.FillPolygon($shineBrush, [System.Drawing.PointF[]] @(
    (New-Point 41 38 $scale),
    (New-Point 64 27 $scale),
    (New-Point 87 38 $scale),
    (New-Point 64 47 $scale)
  ))

  $output = Join-Path $iconDir "icon-$size.png"
  $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

  foreach ($resource in $backgroundBrush, $backgroundPath, $gemBrush, $topBrush, $leftBrush, $rightBrush, $shineBrush) {
    $resource.Dispose()
  }
  $graphics.Dispose()
  $bitmap.Dispose()
}
