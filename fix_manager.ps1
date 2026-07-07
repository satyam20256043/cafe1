$f = 'C:\Users\pc\.gemini\antigravity\scratch\cafe-ai-bot\public\manager.html'
$lines = Get-Content $f
# Lines 381-805 (0-indexed: 380-804) are the orphaned old CSS block
# Keep lines 1-380 (0-indexed: 0-379) and lines 806+ (0-indexed: 805+)
$before = $lines[0..379]
$after = $lines[805..($lines.Length - 1)]
$result = $before + $after
Set-Content $f $result -Encoding UTF8
Write-Host "Done. New total lines: $($result.Length)"
