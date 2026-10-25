import { forwardRef, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { EMIS_LOGIN_URL } from "@/lib/emis-webview-types";
import { EMIS_CRAWLER_CANCEL_SCRIPT, EMIS_CRAWLER_SCRIPT } from "@/lib/emis-crawler";
import { EMIS_AUTO_DISCOVERY_SCRIPT } from "@/lib/emis-auto-discovery";
import type { EmisWebViewHandle, EmisWebViewProps } from "@/lib/emis-webview-types";

function isAllowedHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    return hostname.endsWith(".gov.iq") || hostname === "gov.iq" || hostname.endsWith("cloudflare.com");
  } catch { return false; }
}

const EmisWebView = forwardRef<EmisWebViewHandle, EmisWebViewProps>(function EmisWebView(
  { onMessage, onUrlChange, onPageLoaded },
  ref,
) {
  const webViewRef = useRef<WebView>(null);
  useImperativeHandle(ref, () => ({
    startCrawl: () => webViewRef.current?.injectJavaScript(EMIS_CRAWLER_SCRIPT),
    cancelCrawl: () => webViewRef.current?.injectJavaScript(EMIS_CRAWLER_CANCEL_SCRIPT),
    inspectSession: () => webViewRef.current?.injectJavaScript(EMIS_AUTO_DISCOVERY_SCRIPT),
    navigateTo: (url: string) => {
      if (url.startsWith("https://emis.moedu.gov.iq/")) {
        webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
      }
    },
    reload: () => webViewRef.current?.reload(),
  }), []);

  const handleMessage = (event: WebViewMessageEvent) => {
    onMessage(event.nativeEvent.data, event.nativeEvent.url);
  };
  const handleNavigation = (state: WebViewNavigation) => onUrlChange(state.url);

  return (
    <View style={styles.frame}>
      <WebView
        ref={webViewRef}
        source={{ uri: EMIS_LOGIN_URL }}
        style={styles.webView}
        originWhitelist={["https://*"]}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        cacheEnabled
        setBuiltInZoomControls={false}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigation}
        onLoadEnd={onPageLoaded}
        onShouldStartLoadWithRequest={(request) => isAllowedHost(request.url)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: "hidden", borderRadius: 18, backgroundColor: "#FFFFFF" },
  webView: { flex: 1, backgroundColor: "#FFFFFF" },
});

export default EmisWebView;
