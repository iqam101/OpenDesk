# -*- mode: python ; coding: utf-8 -*-
# Build with:  pyinstaller --noconfirm OpenDesk.spec

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=[('public', 'public')],
    hiddenimports=['win32clipboard', 'webview.platforms.edgechromium', 'webview.platforms.winforms'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['cv2', 'av', 'tkinter', 'customtkinter', 'tkinterdnd2', 'matplotlib', 'scipy', 'pandas'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='OpenDesk',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    icon='assets/icon.ico',
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
