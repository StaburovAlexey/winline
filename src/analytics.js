const MAX_BATCH_SIZE = 99;
const FLUSH_DELAY_MS = 250;
const DEFAULT_PRODUCTION_ENDPOINT = "https://shar.testforspec.ru/api/log";
const DEFAULT_DEVELOPMENT_ENDPOINT = "http://localhost:8000/api/log";

function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readOrCreateId(storage, key) {
  try {
    const storedValue = storage.getItem(key);
    if (storedValue) {
      return storedValue;
    }

    const createdValue = createId();
    storage.setItem(key, createdValue);
    return createdValue;
  } catch (error) {
    return createId();
  }
}

function getClickElement(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest(
    "[data-analytics-target], button, a, [role=button], [id]",
  ) ?? target;
}

function getClickTarget(element) {
  const configuredTarget = element.dataset.analyticsTarget;
  if (configuredTarget) {
    return configuredTarget;
  }

  if (element.id) {
    return element.id;
  }

  const className = [...element.classList].find(
    (classToken) => !classToken.startsWith("is-")
      && !classToken.startsWith("has-")
  );
  return className ?? element.tagName.toLowerCase();
}

export class AnalyticsService {
  constructor({
    endpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT
      || (import.meta.env.DEV
        ? DEFAULT_DEVELOPMENT_ENDPOINT
        : DEFAULT_PRODUCTION_ENDPOINT),
    documentObject = document,
    navigatorObject = navigator,
    locationObject = window.location,
  } = {}) {
    this.endpoint = endpoint;
    this.document = documentObject;
    this.navigator = navigatorObject;
    this.location = locationObject;
    this.userId = readOrCreateId(window.localStorage, "winline:user_id");
    this.sessionId = readOrCreateId(window.sessionStorage, "winline:session_id");
    this.queue = [];
    this.flushTimer = null;
    this.pendingFetches = 0;
    this.currentScreen = null;
    this.viewedScreens = new Set();
    this.disposed = false;
    this.handleClick = this.handleClick.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handlePageHide = this.handlePageHide.bind(this);

    this.document.addEventListener("click", this.handleClick, {
      capture: true,
      passive: true,
    });
    this.document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
      { passive: true },
    );
    window.addEventListener("pagehide", this.handlePageHide, { once: true });
  }

  pageView(screen, props = {}) {
    if (
      this.disposed
      || typeof screen !== "string"
      || this.viewedScreens.has(screen)
    ) {
      return false;
    }

    this.currentScreen = screen;
    this.viewedScreens.add(screen);
    return this.track("page_view", { screen, ...props });
  }

  track(event, props = undefined) {
    if (
      this.disposed
      || typeof event !== "string"
      || event.length === 0
    ) {
      return false;
    }

    const record = {
      event,
      user_id: this.userId,
      session_id: this.sessionId,
      ts: new Date().toISOString(),
      url: this.location.href,
    };
    if (
      props !== undefined
      && props !== null
      && typeof props === "object"
      && !Array.isArray(props)
    ) {
      record.props = props;
    }

    this.queue.push(record);
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
    return true;
  }

  predictionReceived({ source, cardId }) {
    return this.track("prediction_received", {
      source,
      card_id: String(cardId),
    });
  }

  handleClick(event) {
    const element = getClickElement(event.target);
    if (!element) {
      return;
    }

    const href = element instanceof HTMLAnchorElement
      ? element.getAttribute("href")
      : null;
    this.track("click", {
      screen: this.currentScreen,
      target: getClickTarget(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      href,
    });
  }

  scheduleFlush() {
    if (this.flushTimer !== null || this.disposed) {
      return;
    }

    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  flush() {
    if (this.disposed || this.queue.length === 0) {
      return false;
    }

    const events = this.queue.splice(0, MAX_BATCH_SIZE);
    const body = JSON.stringify(events);
    const beaconAccepted = typeof this.navigator.sendBeacon === "function"
      && this.navigator.sendBeacon(
        this.endpoint,
        new Blob([body], { type: "application/json" }),
      );
    if (beaconAccepted) {
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
      return true;
    }

    this.pendingFetches += 1;
    void fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    })
      .catch(() => {})
      .finally(() => {
        this.pendingFetches -= 1;
        if (this.queue.length > 0) {
          this.scheduleFlush();
        }
      });
    return true;
  }

  handleVisibilityChange() {
    if (this.document.visibilityState === "hidden") {
      this.flush();
    }
  }

  handlePageHide() {
    this.flush();
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.flush();
    this.disposed = true;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.document.removeEventListener("click", this.handleClick, true);
    this.document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    window.removeEventListener("pagehide", this.handlePageHide);
  }
}
