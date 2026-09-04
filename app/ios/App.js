// Altovix — native iOS shell. A full-screen WebView around the Altovix web app, with the
// Altovix icon, splash and name, altovix:// deep links (the Scriptable widget uses
// altovix://today) and a safe-area colour that follows the page's light/dark theme.
//
// Set APP_URL to wherever index.html is hosted. Data stays inside the app: the WebView keeps
// its own localStorage, so nothing is shared with Safari.

import React, { useEffect, useRef, useState } from "react";
import { Linking, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";

const APP_URL = "https://jamesskeneco-dev.github.io/Altovix-app/";

const THEMES = {
  light: { bg: "#FFFFFF", bar: "dark" },
  dark: { bg: "#0F1D33", bar: "light" },
};

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const web = useRef(null);
  const [theme, setTheme] = useState("dark");
  const [failed, setFailed] = useState(null);

  // altovix://<tab> opens that tab (today, lists, committee, calibration, book)
  useEffect(() => {
    const open = (url) => {
      const m = /^altovix:\/\/([a-z]+)/i.exec(url || "");
      if (m && web.current) web.current.injectJavaScript(`window.altovixOpen && window.altovixOpen(${JSON.stringify(m[1].toLowerCase())}); true;`);
    };
    Linking.getInitialURL().then(open).catch(() => {});
    const sub = Linking.addEventListener("url", (e) => open(e.url));
    return () => sub.remove();
  }, []);

  const t = THEMES[theme] || THEMES.dark;

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <StatusBar style={t.bar} />
      <SafeAreaView style={styles.safe}>
        {failed ? (
          <View style={styles.err}>
            <Text style={[styles.errTitle, { color: theme === "dark" ? "#E8EEF6" : "#0D213D" }]}>Altovix could not load</Text>
            <Text style={styles.errBody}>{failed}</Text>
            <Pressable style={styles.btn} onPress={() => { setFailed(null); web.current && web.current.reload(); }}>
              <Text style={styles.btnText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        <WebView
          ref={web}
          source={{ uri: APP_URL }}
          style={[styles.web, { backgroundColor: t.bg }, failed ? styles.hidden : null]}
          applicationNameForUserAgent="AltovixApp/1.0"
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          setSupportMultipleWindows={false}
          onLoadEnd={() => SplashScreen.hideAsync().catch(() => {})}
          onError={(e) => setFailed(e.nativeEvent.description || "No connection.")}
          onHttpError={(e) => setFailed("The server answered " + e.nativeEvent.statusCode + ".")}
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              if (msg && msg.type === "theme" && THEMES[msg.theme]) setTheme(msg.theme);
            } catch (err) {}
          }}
          onShouldStartLoadWithRequest={(req) => {
            const inside = req.url.startsWith(APP_URL) || req.url.startsWith("about:");
            if (!inside && req.navigationType === "click") { Linking.openURL(req.url).catch(() => {}); return false; }
            return true;
          }}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  web: { flex: 1 },
  hidden: { flex: 0, height: 0, opacity: 0 },
  err: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  errTitle: { fontSize: 20, fontWeight: "600" },
  errBody: { fontSize: 14, color: "#8C9BB0", textAlign: "center" },
  btn: { marginTop: 8, backgroundColor: "#1C3A64", paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8 },
  btnText: { color: "#FFFFFF", fontWeight: "600" },
});
