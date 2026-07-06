App-level icon files. These MUST live in the app-root static/ directory
(this one), NOT in appserver/static/ - that folder is only for dashboard
JS/CSS/images and Splunk does not look there for the launcher icon. They
were moved here 2026-07-06 because the launcher was showing the default
icon while they sat in appserver/static/.

Present in this directory:

    appIcon.png        36x36  PNG, launcher card / app menu
    appIcon_2x.png     72x72  PNG, high-DPI variant
    appIconAlt.png     36x36  PNG, alt-context variant
    appIconAlt_2x.png  72x72  PNG, high-DPI variant
    appLogo.png        160x40 PNG, app nav bar / store listing
    appLogo_2x.png     320x80 PNG, high-DPI variant
    carbide-512.png    512x512 master artwork (source for the above)

After adding or changing an icon a Splunk restart is usually required
before it appears - the launcher caches app icons aggressively.
