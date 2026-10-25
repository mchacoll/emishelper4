import { useCallback, useRef, useState } from "react";
import { useFonts } from "expo-font";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator, Platform, Pressable, ScrollView, StatusBar, StyleSheet, TextInput, View } from "react-native";
import { CairoText as Text } from "@/components/cairo-text";
import { parseEmisAutoDiscovery, type EmisAutoDiscovery } from "@/lib/emis-auto-discovery";
import EmisWebView from "@/components/emis-webview";
import type { EmisWebViewHandle } from "@/lib/emis-webview-types";
import { EMIS_ORIGIN } from "@/lib/emis-webview-types";
import { parseCrawlMessage } from "@/lib/emis-crawler";
import { StudentCard } from "@/components/student-card";
import { StudentDetail } from "@/components/student-detail";
import { createStudentText, saveStudentExports } from "@/lib/student-export";
import { makeStudentRecord, mergeStudentRecords, requiredFieldValue, type StudentRecord } from "@/lib/student-types";

type MainTab = "students" | "export";
type Phase = "login" | "syncing" | "ready";
type Progress = { message: string; done: number; total: number; page: number };

const REQUIRED_FIELDS = ["اسم الأم", "الاسم الرباعي", "اللقب"];
const COLORS = {
  ink: "#173B3D", muted: "#698184", teal: "#006D77", coral: "#E76F51",
  canvas: "#F2F8F7", border: "#DCE9E7", white: "#FFFFFF", paleTeal: "#E4F1EF", paleCoral: "#FFF0EA",
};

function Button({ title, onPress, tone = "primary", disabled = false, compact = false }: {
  title: string; onPress: () => void; tone?: "primary" | "soft" | "coral" | "outline"; disabled?: boolean; compact?: boolean;
}) {
  const buttonStyle = tone === "primary" ? styles.primaryButton : tone === "coral" ? styles.coralButton : tone === "outline" ? styles.outlineButton : styles.softButton;
  const textStyle = tone === "primary" || tone === "coral" ? styles.buttonTextLight : styles.buttonTextDark;
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [buttonStyle, compact && styles.compactButton, disabled && styles.disabledButton, pressed && !disabled && styles.pressedButton]}>
      <Text style={textStyle}>{title}</Text>
    </Pressable>
  );
}

function safePageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.origin === EMIS_ORIGIN ? parsed.href : "";
  } catch { return ""; }
}

function getMissingRequiredFields(record: StudentRecord): string[] {
  return REQUIRED_FIELDS.filter((name) => !requiredFieldValue(record.fields, name));
}

export default function HomeScreen() {
  useFonts({
    CairoRegular: require("../../assets/fonts/Cairo-Regular.ttf"),
    CairoBold: require("../../assets/fonts/Cairo-Bold.ttf"),
  });
  const [phase, setPhase] = useState<Phase>("login");
  const [activeTab, setActiveTab] = useState<MainTab>("students");
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<StudentRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [progress, setProgress] = useState<Progress>({ message: "جارٍ التحضير…", done: 0, total: 0, page: 0 });
  const [message, setMessage] = useState("سجّل الدخول إلى حسابك في EMIS ليبدأ التطبيق بجلب البيانات تلقائيًا.");
  const [diagnostics, setDiagnostics] = useState("");
  const [lastSummary, setLastSummary] = useState("");
  const webViewRef = useRef<EmisWebViewHandle>(null);
  const currentUrlRef = useRef("https://emis.moedu.gov.iq/auth/login");
  const crawlingRef = useRef(false);
  const listNavigationTriedRef = useRef(false);
  const listWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>("login");
  const goPhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);

  const clearListWait = useCallback(() => {
    if (listWaitTimerRef.current) { clearTimeout(listWaitTimerRef.current); listWaitTimerRef.current = null; }
  }, []);

  const appendRecords = useCallback((incoming: StudentRecord[]) => {
    if (!incoming.length) return;
    setStudents((current) => mergeStudentRecords(current, incoming));
  }, []);

  const startCrawl = useCallback(() => {
    if (Platform.OS === "web" || crawlingRef.current) return;
    crawlingRef.current = true;
    clearListWait();
    setStudents([]);
    setDiagnostics("");
    setProgress({ message: "بدأت قراءة قائمة الطلاب…", done: 0, total: 0, page: 0 });
    goPhase("syncing");
    webViewRef.current?.startCrawl();
  }, [clearListWait, goPhase]);

  const handleCrawlMessage = useCallback((msg: NonNullable<ReturnType<typeof parseCrawlMessage>>) => {
    if (msg.type === "emis-crawl-progress") {
      setProgress({ message: msg.message, done: msg.done, total: msg.total, page: msg.page });
      return;
    }
    if (msg.type === "emis-crawl-records") {
      appendRecords(msg.records.map((record, index) => makeStudentRecord(record.fields, record.profileUrl, `row:${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`)));
      return;
    }
    crawlingRef.current = false;
    setDiagnostics(msg.diagnostics);
    if (msg.type === "emis-crawl-error") {
      setLastSummary(msg.message);
      setMessage(msg.message);
      goPhase("ready");
      return;
    }
    setLastSummary(msg.cancelled ? `أُوقفت المزامنة بعد قراءة ${msg.total} طالبًا.` : `اكتملت المزامنة: ${msg.total} طالبًا من ${msg.pages} صفحة.`);
    setMessage(msg.cancelled ? "أُوقفت المزامنة." : "اكتملت المزامنة بنجاح.");
    goPhase("ready");
  }, [appendRecords, goPhase]);

  const handleAutoDiscovery = useCallback((discovery: EmisAutoDiscovery) => {
    if (crawlingRef.current || phaseRef.current === "ready") return;
    if (!discovery.authenticated) {
      if (discovery.loginForm) {
        listNavigationTriedRef.current = false;
        clearListWait();
        if (phaseRef.current === "syncing") goPhase("login");
      }
      return;
    }
    if (discovery.studentListDetected) { startCrawl(); return; }
    // Signed in but not on the list yet: show the sync screen and open the student list in the background.
    if (phaseRef.current === "login") {
      goPhase("syncing");
      setProgress({ message: "تم تسجيل الدخول — أفتح قائمة الطلاب…", done: 0, total: 0, page: 0 });
      clearListWait();
      listWaitTimerRef.current = setTimeout(() => {
        if (!crawlingRef.current && phaseRef.current === "syncing") {
          goPhase("login");
          setMessage("لم أتمكن من فتح قائمة الطلاب تلقائيًا. افتحها يدويًا مرة واحدة وستبدأ المزامنة فور ظهورها.");
        }
      }, 30000);
    }
    if (discovery.studentListUrl && discovery.studentListUrl !== discovery.pageUrl && !listNavigationTriedRef.current) {
      listNavigationTriedRef.current = true;
      webViewRef.current?.navigateTo(discovery.studentListUrl);
    }
  }, [clearListWait, goPhase, startCrawl]);

  const handleWebMessage = useCallback((raw: string, pageUrl?: string) => {
    if (pageUrl && !safePageUrl(pageUrl)) return;
    const crawl = parseCrawlMessage(raw);
    if (crawl) { handleCrawlMessage(crawl); return; }
    const discovery = parseEmisAutoDiscovery(raw);
    if (discovery) handleAutoDiscovery(discovery);
  }, [handleAutoDiscovery, handleCrawlMessage]);

  const handleUrlChange = useCallback((url: string) => {
    currentUrlRef.current = url;
    if (!crawlingRef.current && phaseRef.current !== "ready" && safePageUrl(url)) {
      setTimeout(() => webViewRef.current?.inspectSession(), 700);
    }
  }, []);

  const handlePageLoaded = useCallback(() => {
    if (!crawlingRef.current && phaseRef.current !== "ready" && safePageUrl(currentUrlRef.current)) {
      setTimeout(() => webViewRef.current?.inspectSession(), 500);
    }
  }, []);

  const cancelSync = useCallback(() => {
    webViewRef.current?.cancelCrawl();
    clearListWait();
    if (!crawlingRef.current) goPhase("login");
  }, [clearListWait, goPhase]);

  const resync = useCallback(() => {
    // Back to the student list in the hidden page, then read again.
    crawlingRef.current = false;
    listNavigationTriedRef.current = false;
    goPhase("syncing");
    setProgress({ message: "أجدّد قراءة البيانات…", done: 0, total: 0, page: 0 });
    webViewRef.current?.reload();
    setTimeout(() => { if (phaseRef.current === "syncing" && !crawlingRef.current) webViewRef.current?.inspectSession(); }, 2500);
  }, [goPhase]);

  const relogin = useCallback(() => {
    crawlingRef.current = false;
    listNavigationTriedRef.current = false;
    setMessage("سجّل الدخول مرة أخرى لتحديث البيانات.");
    goPhase("login");
    webViewRef.current?.reload();
  }, [goPhase]);

  const copyDiagnostics = useCallback(async () => {
    await Clipboard.setStringAsync(diagnostics || lastSummary || "لا يوجد تقرير");
    setMessage("نُسخ تقرير التشخيص إلى الحافظة.");
  }, [diagnostics, lastSummary]);

  const exportAll = useCallback(async () => {
    if (!students.length) { setMessage("لا توجد سجلات حالية لتصديرها."); return; }
    setExporting(true);
    try {
      const result = await saveStudentExports(students);
      setMessage(result.cancelled ? "أُلغي اختيار المجلد؛ لم تُحفظ ملفات." : `تم حفظ ملفي Excel وTXT محليًا: ${result.names.join(" و ")}`);
    } catch (error) {
      setMessage(error instanceof Error ? `تعذّر التصدير: ${error.message}` : "تعذّر إنشاء الملفات.");
    } finally { setExporting(false); }
  }, [students]);

  const copyAll = useCallback(async () => {
    if (!students.length) { setMessage("لا توجد سجلات حالية لنسخها."); return; }
    try {
      await Clipboard.setStringAsync(createStudentText(students));
      setMessage(`نُسخ نص ${students.length} سجلًا إلى الحافظة.`);
    } catch { setMessage("تعذّر النسخ إلى الحافظة على هذا الجهاز."); }
  }, [students]);

  const clearAll = useCallback(() => {
    setStudents([]);
    setConfirmClear(false);
    setMessage("مُسحت السجلات من ذاكرة التطبيق.");
  }, []);

  const filteredStudents = students.filter((student) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return [student.displayName, student.studentNumber, ...Object.values(student.fields)].join(" ").toLowerCase().includes(query);
  });
  const missingCount = students.filter((student) => getMissingRequiredFields(student).length > 0).length;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.canvas} />
      <View style={styles.header}>
        <View style={styles.headerMeta}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>EM</Text></View>
          <View style={styles.headerTitles}>
            <Text style={styles.overline}>{phase === "ready" ? "جاهز" : phase === "syncing" ? "جارٍ المزامنة" : "تسجيل الدخول"}</Text>
            <Text style={styles.title}>مساعد EMIS</Text>
          </View>
        </View>
        {phase === "ready" ? (
          <View style={styles.totalBadge}>
            <Text style={styles.totalValue}>{students.length}</Text>
            <Text style={styles.totalLabel}>طالب</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.stage}>
        {/* The EMIS page stays mounted (it holds the session) but is only visible while signing in. */}
        <View style={phase === "login" ? styles.webVisible : styles.webHidden} pointerEvents={phase === "login" ? "auto" : "none"} collapsable={false}>
          <EmisWebView ref={webViewRef} onMessage={handleWebMessage} onUrlChange={handleUrlChange} onPageLoaded={handlePageLoaded} />
        </View>

        {phase === "login" ? (
          <View style={styles.loginHint}>
            <Text style={styles.helperText}>سجّل الدخول بحسابك؛ سيبدأ التطبيق بجلب البيانات في الخلفية دون إظهار البوابة.</Text>
          </View>
        ) : null}

        {phase === "syncing" ? (
          <View style={styles.syncScreen}>
            <ActivityIndicator size="large" color={COLORS.teal} />
            <Text style={styles.syncTitle}>جارٍ جلب بيانات الطلاب</Text>
            <Text style={styles.syncMessage}>{progress.message}</Text>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${percent}%` }]} /></View>
            <View style={styles.syncStats}>
              <View style={styles.syncStat}><Text style={styles.syncStatValue}>{students.length}</Text><Text style={styles.syncStatLabel}>طالب مقروء</Text></View>
              <View style={styles.syncStat}><Text style={styles.syncStatValue}>{progress.page || "—"}</Text><Text style={styles.syncStatLabel}>الصفحة</Text></View>
              <View style={styles.syncStat}><Text style={styles.syncStatValue}>{progress.total ? `${percent}%` : "—"}</Text><Text style={styles.syncStatLabel}>التقدم</Text></View>
            </View>
            <Text style={styles.syncNote}>لا تغلق التطبيق حتى تكتمل العملية.</Text>
            <Button compact title="إيقاف المزامنة" onPress={cancelSync} tone="outline" />
          </View>
        ) : null}

        {phase === "ready" ? (
          <View style={styles.readyScreen}>
            <View style={styles.tabBar}>
              {([["students", `الطلاب (${students.length})`], ["export", "تصدير"]] as [MainTab, string][]).map(([tab, label]) => (
                <Pressable key={tab} onPress={() => setActiveTab(tab)} style={[styles.tab, activeTab === tab && styles.activeTab]}>
                  <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>{label}</Text>
                </Pressable>
              ))}
            </View>

            {activeTab === "students" ? (
              <View style={styles.contentScreen}>
                <View style={styles.summaryRow}>
                  <Text style={styles.sectionSub}>{lastSummary || (students.length ? `إجمالي السجلات: ${students.length}` : "لا توجد سجلات")}</Text>
                  <Pressable onPress={resync} style={styles.reloadButton}><Text style={styles.reloadText}>تحديث</Text></Pressable>
                </View>
                {missingCount ? <Text style={styles.warnText}>{missingCount} سجلًا ينقصه اسم الأم أو الاسم الرباعي أو اللقب.</Text> : null}
                <TextInput value={search} onChangeText={setSearch} placeholder="ابحث بالاسم أو أي حقل…" placeholderTextColor="#849799" style={styles.searchInput} textAlign="right" accessibilityLabel="البحث في سجلات الطلاب" />
                {filteredStudents.length ? (
                  <ScrollView contentContainerStyle={styles.studentList} keyboardShouldPersistTaps="handled">
                    {filteredStudents.map((record, index) => <StudentCard key={record.recordKey} record={record} index={index} onPress={() => setSelectedStudent(record)} />)}
                  </ScrollView>
                ) : (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}><Text style={styles.emptyIconText}>≡</Text></View>
                    <Text style={styles.emptyTitle}>{students.length ? "لا توجد نتائج" : "لم تُقرأ أي بيانات"}</Text>
                    <Text style={styles.emptyCopy}>{students.length ? "جرّب كلمة بحث مختلفة." : "اضغط تحديث لإعادة المحاولة، أو أعد تسجيل الدخول. يمكنك نسخ تقرير التشخيص وإرساله للمطوّر."}</Text>
                    {!students.length ? (
                      <View style={styles.rowButtons}>
                        <Button compact title="إعادة تسجيل الدخول" onPress={relogin} tone="soft" />
                        <Button compact title="نسخ تقرير التشخيص" onPress={copyDiagnostics} tone="outline" />
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            ) : (
              <ScrollView style={styles.contentScreen} contentContainerStyle={styles.exportScreen}>
                <View style={styles.exportSummary}><Text style={styles.exportSummaryValue}>{students.length}</Text><Text style={styles.exportSummaryLabel}>سجل جاهز للتصدير</Text></View>
                <Button title={exporting ? "جارٍ تجهيز الملفات…" : "تصدير Excel وTXT"} onPress={exportAll} disabled={exporting || students.length === 0} />
                <Button title="نسخ النص الكامل" onPress={copyAll} tone="soft" disabled={students.length === 0} />
                <Button title="إعادة تسجيل الدخول" onPress={relogin} tone="soft" />
                {diagnostics ? <Button title="نسخ تقرير التشخيص" onPress={copyDiagnostics} tone="outline" /> : null}
                {students.length ? <Button title="مسح سجلات الذاكرة" onPress={() => setConfirmClear(true)} tone="outline" /> : null}
                <View style={styles.exportNote}>
                  <Text style={styles.exportNoteTitle}>البيانات محلية فقط</Text>
                  <Text style={styles.exportNoteBody}>لا يُرسل التطبيق أي بيانات لأي جهة. الملفات المصدّرة غير مشفرة، فاحفظها وشاركها بحذر.</Text>
                </View>
                {confirmClear ? (
                  <View style={styles.confirmBox}>
                    <Text style={styles.confirmTitle}>مسح السجلات من الذاكرة؟</Text>
                    <Text style={styles.confirmBody}>لن تُحذف الملفات التي حفظتها في مجلد الهاتف.</Text>
                    <View style={styles.confirmActions}><Button title="إلغاء" onPress={() => setConfirmClear(false)} tone="soft" compact /><Button title="مسح الآن" onPress={clearAll} tone="coral" compact /></View>
                  </View>
                ) : null}
              </ScrollView>
            )}
          </View>
        ) : null}
      </View>

      <View style={styles.messageBar}>
        <View style={styles.messageMark}><Text style={styles.messageMarkText}>i</Text></View>
        <Text style={styles.messageText} numberOfLines={3}>{message}</Text>
      </View>
      <StudentDetail record={selectedStudent} onClose={() => setSelectedStudent(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, minHeight: 0 },
  webVisible: { flex: 1, borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white },
  webHidden: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.01 },
  loginHint: { paddingTop: 6 },
  syncScreen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 20, backgroundColor: COLORS.canvas },
  syncTitle: { color: COLORS.ink, fontSize: 20, fontFamily: "CairoBold" },
  syncMessage: { color: COLORS.muted, fontSize: 13, textAlign: "center", fontFamily: "CairoRegular" },
  progressTrack: { width: "100%", height: 10, borderRadius: 6, backgroundColor: COLORS.paleTeal, overflow: "hidden" },
  progressFill: { height: 10, borderRadius: 6, backgroundColor: COLORS.teal },
  syncStats: { flexDirection: "row-reverse", gap: 10, width: "100%" },
  syncStat: { flex: 1, minHeight: 66, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center" },
  syncStatValue: { color: COLORS.teal, fontSize: 20, fontFamily: "CairoBold" },
  syncStatLabel: { color: COLORS.muted, fontSize: 11, fontFamily: "CairoRegular" },
  syncNote: { color: COLORS.muted, fontSize: 11, fontFamily: "CairoRegular" },
  readyScreen: { flex: 1, minHeight: 0, backgroundColor: COLORS.canvas },
  summaryRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingBottom: 8 },
  warnText: { color: COLORS.coral, fontSize: 11, textAlign: "right", paddingBottom: 8, fontFamily: "CairoRegular" },
  rowButtons: { flexDirection: "row-reverse", gap: 8, paddingTop: 6 },
  safeArea: { flex: 1, backgroundColor: COLORS.canvas, paddingHorizontal: 16 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.canvas },
  header: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingTop: 6, paddingBottom: 11 },
  headerMeta: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  brandMark: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.teal },
  brandMarkText: { color: COLORS.white, fontSize: 14, fontFamily: "CairoBold" },
  headerTitles: { alignItems: "flex-end" },
  overline: { color: COLORS.coral, fontSize: 10, fontFamily: "CairoBold" },
  title: { color: COLORS.ink, fontSize: 20, fontFamily: "CairoBold" },
  totalBadge: { minWidth: 62, height: 48, paddingHorizontal: 11, borderRadius: 15, backgroundColor: COLORS.white, borderColor: COLORS.border, borderWidth: 1, alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 5 },
  totalValue: { color: COLORS.teal, fontSize: 20, fontFamily: "CairoBold" },
  totalLabel: { color: COLORS.muted, fontSize: 11, fontFamily: "CairoRegular" },
  privacyBanner: { minHeight: 35, backgroundColor: "#E8F2F0", borderRadius: 11, paddingHorizontal: 10, flexDirection: "row-reverse", alignItems: "center", gap: 8, marginBottom: 10 },
  bannerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.teal },
  privacyText: { color: "#48696C", fontSize: 11, flex: 1, textAlign: "right", fontFamily: "CairoRegular" },
  tabBar: { flexDirection: "row-reverse", backgroundColor: "#E5EFED", borderRadius: 14, padding: 4, marginBottom: 10, gap: 4 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 39, borderRadius: 11, paddingHorizontal: 4 },
  activeTab: { backgroundColor: COLORS.teal },
  tabText: { color: "#5E7779", fontSize: 12, fontFamily: "CairoBold" },
  activeTabText: { color: COLORS.white },
  portalScreen: { flex: 1, minHeight: 240 },
  hiddenScreen: { display: "none" },
  portalStatus: { flexDirection: "row-reverse", alignItems: "center", gap: 7, paddingBottom: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 5 },
  statusDotLive: { backgroundColor: COLORS.teal },
  statusDotOff: { backgroundColor: COLORS.coral },
  portalStatusText: { flex: 1, color: COLORS.ink, fontSize: 12, fontFamily: "CairoBold", textAlign: "right" },
  reloadButton: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: COLORS.white, borderColor: COLORS.border, borderWidth: 1, borderRadius: 9 },
  reloadText: { color: COLORS.teal, fontSize: 11, fontFamily: "CairoBold" },
  webViewPanel: { flex: 1, minHeight: 220, borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white },
  actionRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingTop: 9 },
  syncSpinner: { width: 24 },
  helperText: { color: COLORS.muted, fontSize: 11, textAlign: "right", paddingTop: 5, paddingBottom: 4, fontFamily: "CairoRegular" },
  contentScreen: { flex: 1, minHeight: 0 },
  sectionHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingTop: 4, paddingBottom: 13 },
  sectionCopy: { alignItems: "flex-end", gap: 2 },
  sectionTitle: { color: COLORS.ink, fontSize: 21, fontFamily: "CairoBold" },
  sectionSub: { color: COLORS.muted, fontSize: 12, fontFamily: "CairoRegular", textAlign: "right" },
  countBubble: { width: 43, height: 43, borderRadius: 15, backgroundColor: COLORS.paleTeal, alignItems: "center", justifyContent: "center" },
  countBubbleText: { color: COLORS.teal, fontSize: 17, fontFamily: "CairoBold" },
  searchInput: { height: 46, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white, paddingHorizontal: 14, color: COLORS.ink, fontFamily: "CairoRegular", marginBottom: 12 },
  studentList: { paddingBottom: 16 },
  emptyState: { flex: 1, minHeight: 250, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 10 },
  emptyIcon: { width: 54, height: 54, borderRadius: 19, backgroundColor: COLORS.paleTeal, alignItems: "center", justifyContent: "center" },
  emptyIconText: { color: COLORS.teal, fontSize: 28 },
  emptyTitle: { color: COLORS.ink, fontSize: 18, fontFamily: "CairoBold" },
  emptyCopy: { color: COLORS.muted, textAlign: "center", lineHeight: 22, fontSize: 13, fontFamily: "CairoRegular" },
  exportScreen: { gap: 11, paddingBottom: 18 },
  exportGlyph: { width: 43, height: 43, borderRadius: 15, backgroundColor: COLORS.paleCoral, alignItems: "center", justifyContent: "center" },
  exportGlyphText: { color: COLORS.coral, fontSize: 24, fontWeight: "800" },
  exportSummary: { minHeight: 88, borderRadius: 18, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", gap: 0 },
  exportSummaryValue: { color: COLORS.teal, fontSize: 30, fontFamily: "CairoBold" },
  exportSummaryLabel: { color: COLORS.muted, fontSize: 12, fontFamily: "CairoRegular" },
  primaryButton: { minHeight: 47, paddingHorizontal: 16, borderRadius: 14, backgroundColor: COLORS.teal, alignItems: "center", justifyContent: "center", flex: 1 },
  softButton: { minHeight: 47, paddingHorizontal: 16, borderRadius: 14, backgroundColor: COLORS.paleTeal, alignItems: "center", justifyContent: "center", flex: 1 },
  coralButton: { minHeight: 47, paddingHorizontal: 16, borderRadius: 14, backgroundColor: COLORS.coral, alignItems: "center", justifyContent: "center", flex: 1 },
  outlineButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: "#ECC5B7", backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", flex: 1 },
  compactButton: { minHeight: 38, paddingHorizontal: 14 },
  disabledButton: { opacity: 0.42 },
  pressedButton: { opacity: 0.78 },
  buttonTextLight: { color: COLORS.white, fontSize: 14, fontFamily: "CairoBold", textAlign: "center" },
  buttonTextDark: { color: COLORS.teal, fontSize: 14, fontFamily: "CairoBold", textAlign: "center" },
  exportNote: { padding: 14, borderRadius: 16, backgroundColor: "#E8F2F0", gap: 5 },
  exportNoteTitle: { color: COLORS.ink, fontSize: 14, fontFamily: "CairoBold", textAlign: "right" },
  exportNoteBody: { color: "#587376", fontSize: 12, lineHeight: 21, fontFamily: "CairoRegular", textAlign: "right" },
  confirmBox: { borderWidth: 1, borderColor: "#F1C7B9", backgroundColor: "#FFF9F6", borderRadius: 16, padding: 13, gap: 6 },
  confirmTitle: { color: COLORS.ink, fontSize: 15, fontFamily: "CairoBold", textAlign: "right" },
  confirmBody: { color: COLORS.muted, fontSize: 12, fontFamily: "CairoRegular", textAlign: "right" },
  confirmActions: { flexDirection: "row-reverse", gap: 8, paddingTop: 5 },
  messageBar: { minHeight: 46, flexDirection: "row-reverse", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 8, paddingBottom: 2 },
  messageMark: { width: 20, height: 20, borderRadius: 7, backgroundColor: COLORS.paleTeal, alignItems: "center", justifyContent: "center" },
  messageMarkText: { color: COLORS.teal, fontSize: 12, fontFamily: "CairoBold" },
  messageText: { flex: 1, color: COLORS.muted, fontSize: 11, lineHeight: 17, textAlign: "right", fontFamily: "CairoRegular" },
});
