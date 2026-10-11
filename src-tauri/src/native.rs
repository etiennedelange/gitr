//! Make the WebView2 window behave like a native app rather than a browser tab.

use tauri::WebviewWindow;

/// Turns off the browser context menu, browser shortcuts (F5, Ctrl+F, F12, …), and autofill.
/// The page still receives key events, so Gitr's own shortcuts keep working.
pub fn harden(window: &WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|wv| {
        if let Err(e) = unsafe { harden_webview2(&wv.controller()) } {
            eprintln!("could not harden WebView2: {e}");
        }
    });
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
unsafe fn harden_webview2(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2Settings4};
    use windows_core::Interface;

    unsafe {
        let settings = controller.CoreWebView2()?.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false)?;
        let s4 = settings.cast::<ICoreWebView2Settings4>()?;
        s4.SetIsPasswordAutosaveEnabled(false)?;
        s4.SetIsGeneralAutofillEnabled(false)?;
    }
    Ok(())
}
