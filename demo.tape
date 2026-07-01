# tokenwise demo — record with:  vhs demo.tape   (https://github.com/charmbracelet/vhs)
# Produces assets/demo.gif. Run from the repo root after `brew install vhs`.
Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 720
Set Theme "Catppuccin Mocha"
Set Padding 18
Set TypingSpeed 45ms

Type "# What did my last Claude Code session cost?"
Enter
Sleep 800ms
Type "node ~/.claude/skills/tokenwise/scripts/analyze.mjs"
Enter
Sleep 3s

Type "# And the trend across every session in this project:"
Enter
Sleep 800ms
Type "node ~/.claude/skills/tokenwise/scripts/analyze.mjs --trend"
Enter
Sleep 3.5s
