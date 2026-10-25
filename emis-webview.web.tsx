import { forwardRef, useImperativeHandle } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { CairoText as Text } from "@/components/cairo-text";
import { EMIS_LOGIN_URL } from "@/lib/emis-webview-types";
import type { EmisWebViewHandle, EmisWebViewProps } from "@/lib/emis-webview-types";

const EmisWebView = forwardRef<EmisWebViewHandle, EmisWebViewProps>(function EmisWebView(_props, ref) {
  useImperativeHandle(ref, () => ({
    startCrawl: () => undefined,
    cancelCrawl: () => undefined,
    inspectSession: () => undefined,
    navigateTo: () => undefined,
    reload: () => undefined,
  }), []);

  return (
    <View style={styles.container}>
      <View style={styles.icon}><Text style={styles.iconText}>EMIS</Text></View>
      <Text style={styles.title}>صفحة EMIS الرسمية</Text>
      <Text style={styles.copy}>
        تسجيل الدخول والمزامنة داخل الموقع متاحان في تطبيق Android. في معاينة الويب افتح البوابة في نافذة مستقلة.
      </Text>
      <Pressable style={styles.button} onPress={() => Linking.openURL(EMIS_LOGIN_URL)}>
        <Text style={styles.buttonText}>فتح بوابة EMIS</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 300, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "#F2F8F7", borderRadius: 18, gap: 14 },
  icon: { width: 82, height: 82, borderRadius: 24, backgroundColor: "#006D77", alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 20, fontWeight: "800", color: "#FFFFFF", letterSpacing: 1 },
  title: { fontSize: 20, fontWeight: "800", color: "#123B3E", textAlign: "center" },
  copy: { maxWidth: 430, fontSize: 14, lineHeight: 23, color: "#547073", textAlign: "center" },
  button: { borderRadius: 14, backgroundColor: "#006D77", paddingVertical: 13, paddingHorizontal: 22 },
  buttonText: { color: "#FFFFFF", fontWeight: "800", fontSize: 15 },
});

export default EmisWebView;
