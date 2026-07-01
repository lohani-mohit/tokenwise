# tokenwise demo — record with:  vhs demo.tape   (https://github.com/charmbracelet/vhs)
# Produces assets/demo.gif. Run from the repo root after `brew install vhs`.
Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1160
Set Height 760
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms

# Run from a dir that has real Claude Code sessions so the demo is populated.
Hide
Type "cd ~/Desktop && clear" Enter
Show
Sleep 500ms

Type "# What did my last Claude Code session cost?"
Enter
Sleep 700ms
Type "node ~/.claude/skills/tokenwise/scripts/analyze.mjs | head -13"
Enter
Sleep 3.5s

Type "clear" Enter
Sleep 300ms
Type "# Cost across every session in this project:"
Enter
Sleep 700ms
Type "node ~/.claude/skills/tokenwise/scripts/analyze.mjs --trend"
Enter
Sleep 4s
