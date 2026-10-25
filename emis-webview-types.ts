export type EmisWebViewHandle = {
  startCrawl: () => void;
  cancelCrawl: () => void;
  inspectSession: () => void;
  navigateTo: (url: string) => void;
  reload: () => void;
};

export type EmisWebViewProps = {
  onMessage: (message: string, pageUrl?: string) => void;
  onUrlChange: (url: string) => void;
  onPageLoaded: () => void;
};

export const EMIS_LOGIN_URL = "https://emis.moedu.gov.iq/auth/login";
export const EMIS_ORIGIN = "https://emis.moedu.gov.iq";
