# Terminal demo for the README. Render from the repository root after `npm run build`:
#   vhs docs/demo.tape
# Uses only the synthetic logs from scripts/make-demo-data.mjs, never real session logs.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1420
Set Height 1060
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 12

Hide
Type `export BASH_SILENCE_DEPRECATION_WARNING=1 PS1='$ ' NW="node $PWD/dist/cli.js"` Enter
Type `alias nerf-watch="$NW"` Enter
Type `rm -rf /tmp/nerf-watch-demo && node scripts/make-demo-data.mjs /tmp/nerf-watch-demo/logs > /dev/null` Enter
Type `export HOME=/tmp/nerf-watch-demo/home && mkdir -p $HOME && cd /tmp/nerf-watch-demo/logs && clear` Enter
Sleep 1s
Show

Type "# synthetic session logs (no real data) with planted regressions"
Sleep 700ms
Enter
Sleep 300ms
Type "nerf-watch check --root claude=claude/projects --root codex=codex/sessions --agent claude"
Sleep 800ms
Enter
Sleep 10s
