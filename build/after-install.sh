#!/bin/sh
set -e

# electron-builder's DEFAULT deb postinst sets the setuid bit on chrome-sandbox.
# Supplying an `afterInstall` script (package.json → build.deb.afterInstall)
# REPLACES that default rather than adding to it, so it has to be done here —
# without it Chromium aborts on every launch with "The SUID sandbox helper
# binary was found, but is not configured correctly."
# The path tracks build.productName; update both together.
APPDIR='/opt/StickyNotes'
SANDBOX="$APPDIR/chrome-sandbox"
# The install dir must not contain a space: Chromium word-splits the sandbox
# helper path when it launches the zygote ("failed to execvp: /opt/Sticky"),
# which is why build.productName is "StickyNotes" and the human-readable name
# lives in build.linux.desktop.Name instead.
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" || true
  chmod 4755 "$SANDBOX" || true
fi

# Also replaced along with the default postinst: the launcher on PATH.
if [ -x "$APPDIR/sticky-notes-canvas" ]; then
  ln -sf "$APPDIR/sticky-notes-canvas" /usr/bin/sticky-notes-canvas || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  if [ -d /usr/share/icons/hicolor ]; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
  fi
fi

exit 0
