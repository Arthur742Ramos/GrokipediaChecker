# Grokipedia Checker Operations Guide

## Starting the Checker

Use the startup script which syncs cookies before running:

```bash
~/start-checker.sh -n 10000000 -p 10
```

This script:
1. Syncs cookies from snap Chromium to Playwright profile
2. Starts the checker with specified parameters

## Cookie Refresh

A cron job runs every 20 minutes to keep cookies fresh:

```
*/20 * * * * cp -f $HOME/snap/chromium/common/chromium/Default/Cookies $HOME/.config/chromium-persistent/chromium-vnc/Default/Cookies
```

This beats the 30-minute Cloudflare session cookie expiry.

## Browser Login

If cookies expire completely:
1. Connect via VNC: `104.45.202.241:5901` (password: flow2026)
2. Open Chromium and log in to grokipedia.com
3. Cookies will auto-sync within 20 minutes, or run manually:
   ```bash
   cp -f ~/snap/chromium/common/chromium/Default/Cookies ~/.config/chromium-persistent/chromium-vnc/Default/Cookies
   ```
4. Restart the checker: `~/start-checker.sh -n 10000000 -p 10`

## Monitoring

Check status:
```bash
ps aux | grep "node dist/index" | grep -v grep
tail -50 /tmp/grokipedia-checker.log
grep -c "Correction submitted" /tmp/grokipedia-checker.log  # count fixes
```

Check for auth issues:
```bash
grep "Not signed in" /tmp/grokipedia-checker.log | tail -5
```
