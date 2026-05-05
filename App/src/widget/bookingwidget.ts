/**
 * Booking widget — embeddable client-side renderer.
 *
 * A self-mounting browser script that renders a 4-step booking form into
 * a host-page element. Talks to the Functions App's /api/slots and
 * /api/bookings endpoints to fetch availability and create appointments.
 *
 * Embed contract:
 *   <div id="booking-widget" data-tenant="<slug>"></div>
 *   <script src="https://<host>/bookingwidget.js"></script>
 *
 * Steps:
 *   1. Date and Time      — calendar grid + time slot panel
 *   2. Your Info          — contact form (first/last/email + optional)
 *   3. Confirm            — review summary + submit
 *   4. Success            — post-booking confirmation screen
 *
 * The script auto-detects its own origin (from its script tag's `src`) and
 * builds the API URLs and CSS URL relative to that origin. The host page
 * therefore needs only the two-line snippet — no separate stylesheet link,
 * no API URL configuration, no business identifier exposure.
 *
 * Algorithmic port of the WordPress plugin's `booking-form.js` (v0.5.x).
 * Differences:
 *   - Tenant slug is passed in URL/body parameters (was implicit in the WP plugin)
 *   - WP nonce is replaced by the architecture's defense-in-depth (CORS +
 *     honeypot + time-to-submit + rate limit); see ADR-0011
 *   - All names/identifiers are brand-neutral; the visible labels
 *     ("Schedule a Call", "Date and Time", etc.) live in the LABELS object
 *     below for easy customization
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------------
  // Origin and config detection
  // ------------------------------------------------------------------------

  const SCRIPT_ELEMENT = (document.currentScript as HTMLScriptElement | null) ?? findOwnScript();
  if (!SCRIPT_ELEMENT) {
    console.error('[booking-widget] Could not locate own <script> tag; aborting.');
    return;
  }

  let scriptUrl: URL;
  try {
    scriptUrl = new URL(SCRIPT_ELEMENT.src);
  } catch (err) {
    console.error('[booking-widget] script src is not a valid URL:', err);
    return;
  }

  const API_BASE = `${scriptUrl.origin}/api`;
  const CSS_URL = `${scriptUrl.origin}/bookingwidget.css`;

  /** Captured at script-init time; sent in the booking submission for the time-to-submit guard. */
  const FORM_INIT_TIME_MS = Date.now();

  /** Visible labels. Pulled out so deployments can later inject overrides via a config attribute. */
  const LABELS = {
    loadingTimes: 'Loading available times…',
    fallbackTitle: 'Online scheduling temporarily unavailable',
    fallbackBody: 'Please try again in a moment, or contact us directly to schedule a call.',
    step1Title: 'Date and Time',
    step2Title: 'Your Info',
    step3Title: 'Confirm',
    step4Title: 'Confirmed',
    monthsLong: ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'],
    weekdaysShort: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
    weekdaysLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    pickADate: 'Pick a date to see available times.',
    noTimesForDate: 'No available times on this date.',
    timesShownIn: 'Times shown in {tz} (your local time)',
    fields: {
      firstName: 'First Name',
      lastName: 'Last Name',
      email: 'Work Email',
      company: 'Company',
      phone: 'Phone',
      notes: 'Tell us about your situation',
    },
    required: 'required',
    continueButton: 'Continue',
    backButton: 'Back',
    confirmButton: 'Confirm Booking',
    submittingButton: 'Submitting…',
    successTitle: 'Booking Confirmed',
    successSubtitle: 'A calendar invite with a Microsoft Teams link will be sent to your email.',
    successJoinPrefix: 'Or join the meeting directly: ',
    summaryHeading: 'Review your booking',
    summaryDate: 'Date',
    summaryTime: 'Time',
    summaryName: 'Name',
    summaryEmail: 'Email',
    summaryCompany: 'Company',
  };

  // ------------------------------------------------------------------------
  // Types and state
  // ------------------------------------------------------------------------

  type Step = 1 | 2 | 3 | 4;

  /** Slots map: keys are "YYYY-MM-DD" (business-local), values are ISO 8601 UTC datetimes. */
  type SlotMap = Record<string, string[]>;

  interface FormFields {
    firstName: string;
    lastName: string;
    email: string;
    company: string;
    phone: string;
    notes: string;
  }

  interface State {
    step: Step;
    tenant: string;
    slots: SlotMap;
    selectedDate: string | null;
    selectedTime: string | null;
    calYear: number;
    calMonth: number; // 0-indexed
    isLoading: boolean;
    isSubmitting: boolean;
    errorMessage: string | null;
    fetchFailed: boolean;
    form: FormFields;
    successJoinUrl: string;
  }

  const today = new Date();

  const state: State = {
    step: 1,
    tenant: '',
    slots: {},
    selectedDate: null,
    selectedTime: null,
    calYear: today.getFullYear(),
    calMonth: today.getMonth(),
    isLoading: false,
    isSubmitting: false,
    errorMessage: null,
    fetchFailed: false,
    form: { firstName: '', lastName: '', email: '', company: '', phone: '', notes: '' },
    successJoinUrl: '',
  };

  let mountEl: HTMLElement | null = null;

  function update(patch: Partial<State>): void {
    Object.assign(state, patch);
  }

  // ------------------------------------------------------------------------
  // Mount and initialization
  // ------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init(): void {
    mountEl = document.getElementById('booking-widget');
    if (!mountEl) {
      console.error(
        '[booking-widget] No element with id="booking-widget" found. ' +
          'The host page must include <div id="booking-widget" data-tenant="…"></div>.'
      );
      return;
    }

    const tenant = mountEl.getAttribute('data-tenant') ?? '';
    if (!tenant) {
      mountEl.innerHTML = '';
      mountEl.appendChild(
        errorBlock(
          'Configuration error',
          'The booking widget is missing the data-tenant attribute. Add it to the mount element.'
        )
      );
      return;
    }

    state.tenant = tenant;
    mountEl.classList.add('bw-container');

    injectStylesheet();
    void fetchSlots();
    render();
  }

  function injectStylesheet(): void {
    if (document.querySelector(`link[data-bw-stylesheet]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.setAttribute('data-bw-stylesheet', '');
    document.head.appendChild(link);
  }

  // ------------------------------------------------------------------------
  // API calls
  // ------------------------------------------------------------------------

  async function fetchSlots(): Promise<void> {
    update({ isLoading: true, fetchFailed: false });
    render();

    try {
      const url = `${API_BASE}/slots?tenant=${encodeURIComponent(state.tenant)}`;
      const response = await fetch(url, { method: 'GET', credentials: 'omit' });
      if (!response.ok) {
        throw new Error(`Slot fetch failed: HTTP ${response.status}`);
      }
      const data = (await response.json()) as { slots?: SlotMap };
      update({ slots: data.slots ?? {}, isLoading: false });
    } catch (err) {
      console.error('[booking-widget] fetchSlots failed:', err);
      update({ isLoading: false, fetchFailed: true });
    }
    render();
  }

  async function submitBooking(): Promise<void> {
    if (state.isSubmitting || !state.selectedTime) return;
    update({ isSubmitting: true, errorMessage: null });
    render();

    const payload = {
      tenant: state.tenant,
      firstName: state.form.firstName,
      lastName: state.form.lastName,
      email: state.form.email,
      phone: state.form.phone,
      company: state.form.company,
      notes: state.form.notes,
      startTime: state.selectedTime,
      customerTimezone: detectTimezone(),
      website: '', // Honeypot — must remain empty.
      formLoadedMs: Date.now() - FORM_INIT_TIME_MS,
    };

    try {
      const response = await fetch(`${API_BASE}/bookings`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as {
        success?: boolean;
        joinUrl?: string;
        message?: string;
      };
      if (data.success) {
        update({
          step: 4,
          isSubmitting: false,
          successJoinUrl: data.joinUrl ?? '',
        });
      } else {
        update({
          errorMessage: data.message ?? 'Unable to complete your booking. Please try again.',
          isSubmitting: false,
        });
      }
    } catch (err) {
      console.error('[booking-widget] submitBooking failed:', err);
      update({
        errorMessage: 'Network error. Please check your connection and try again.',
        isSubmitting: false,
      });
    }
    render();
  }

  // ------------------------------------------------------------------------
  // Rendering — top level
  // ------------------------------------------------------------------------

  function render(): void {
    if (!mountEl) return;
    mountEl.innerHTML = '';

    if (state.fetchFailed) {
      mountEl.appendChild(fallbackCard());
      return;
    }

    if (state.isLoading && state.step === 1 && Object.keys(state.slots).length === 0) {
      mountEl.appendChild(loadingCard());
      return;
    }

    mountEl.appendChild(stepIndicator());

    if (state.errorMessage) {
      mountEl.appendChild(errorBanner(state.errorMessage));
    }

    switch (state.step) {
      case 1:
        mountEl.appendChild(renderStep1());
        break;
      case 2:
        mountEl.appendChild(renderStep2());
        break;
      case 3:
        mountEl.appendChild(renderStep3());
        break;
      case 4:
        mountEl.appendChild(renderStep4());
        break;
    }
  }

  function loadingCard(): HTMLElement {
    return el('div', { className: 'bw-loading', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, [LABELS.loadingTimes]),
    ]);
  }

  function fallbackCard(): HTMLElement {
    return el('div', { className: 'bw-fallback', role: 'alert' }, [
      el('h3', {}, [LABELS.fallbackTitle]),
      el('p', {}, [LABELS.fallbackBody]),
    ]);
  }

  function errorBlock(title: string, message: string): HTMLElement {
    return el('div', { className: 'bw-fallback', role: 'alert' }, [
      el('h3', {}, [title]),
      el('p', {}, [message]),
    ]);
  }

  function errorBanner(message: string): HTMLElement {
    return el('div', { className: 'bw-error-banner', role: 'alert' }, [message]);
  }

  function stepIndicator(): HTMLElement {
    const steps: Array<[number, string]> = [
      [1, LABELS.step1Title],
      [2, LABELS.step2Title],
      [3, LABELS.step3Title],
    ];
    if (state.step === 4) {
      steps.push([4, LABELS.step4Title]);
    }

    const indicator = el('div', { className: 'bw-steps', 'aria-label': 'Booking progress' });
    steps.forEach(([num, label], i) => {
      const stepClass =
        num === state.step ? 'bw-step bw-step-active' :
        num < state.step ? 'bw-step bw-step-done' :
        'bw-step';
      indicator.appendChild(
        el('div', { className: stepClass }, [
          el('span', { className: 'bw-step-num' }, [String(num)]),
          el('span', { className: 'bw-step-label' }, [label]),
        ])
      );
      if (i < steps.length - 1) {
        indicator.appendChild(el('div', { className: 'bw-step-connector' }));
      }
    });
    return indicator;
  }

  // ------------------------------------------------------------------------
  // Step 1: Date and Time
  // ------------------------------------------------------------------------

  function renderStep1(): HTMLElement {
    const wrap = el('div', { className: 'bw-step1' });
    wrap.appendChild(renderCalendar());
    wrap.appendChild(renderTimePanel());
    return wrap;
  }

  function renderCalendar(): HTMLElement {
    const cal = el('div', { className: 'bw-calendar' });

    // Header with month/year and prev/next buttons
    const header = el('div', { className: 'bw-cal-header' });
    const prevBtn = el(
      'button',
      { type: 'button', className: 'bw-cal-nav', 'aria-label': 'Previous month' },
      ['←']
    );
    prevBtn.addEventListener('click', () => navigateMonth(-1));
    const nextBtn = el(
      'button',
      { type: 'button', className: 'bw-cal-nav', 'aria-label': 'Next month' },
      ['→']
    );
    nextBtn.addEventListener('click', () => navigateMonth(1));

    const title = el('div', { className: 'bw-cal-title' }, [
      `${LABELS.monthsLong[state.calMonth]} ${state.calYear}`,
    ]);
    header.appendChild(prevBtn);
    header.appendChild(title);
    header.appendChild(nextBtn);
    cal.appendChild(header);

    // Weekday header row
    const weekdayRow = el('div', { className: 'bw-cal-weekdays' });
    for (const wd of LABELS.weekdaysShort) {
      weekdayRow.appendChild(el('div', { className: 'bw-cal-weekday' }, [wd]));
    }
    cal.appendChild(weekdayRow);

    // Day cells
    const grid = el('div', { className: 'bw-cal-grid' });
    const firstDay = new Date(state.calYear, state.calMonth, 1);
    const startOffset = firstDay.getDay();
    const daysInMonth = new Date(state.calYear, state.calMonth + 1, 0).getDate();

    // Empty cells for days before the 1st
    for (let i = 0; i < startOffset; i++) {
      grid.appendChild(el('div', { className: 'bw-cal-day bw-cal-empty' }));
    }
    // Day cells
    const todayKey = formatDateKey(today);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(state.calYear, state.calMonth, d);
      const dateKey = formatDateKey(date);
      const hasSlots = (state.slots[dateKey]?.length ?? 0) > 0;
      const isPast = dateKey < todayKey;
      const isSelected = state.selectedDate === dateKey;
      const isToday = dateKey === todayKey;

      const classes = ['bw-cal-day'];
      if (hasSlots && !isPast) classes.push('bw-cal-available');
      else classes.push('bw-cal-unavailable');
      if (isSelected) classes.push('bw-cal-selected');
      if (isToday) classes.push('bw-cal-today');

      const dayBtn = el(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          'aria-label': `${LABELS.monthsLong[state.calMonth]} ${d}`,
        },
        [String(d)]
      );
      if (hasSlots && !isPast) {
        dayBtn.addEventListener('click', () => selectDate(dateKey));
      } else {
        dayBtn.setAttribute('disabled', '');
      }
      grid.appendChild(dayBtn);
    }
    cal.appendChild(grid);
    return cal;
  }

  function renderTimePanel(): HTMLElement {
    const panel = el('div', { className: 'bw-times' });

    if (!state.selectedDate) {
      panel.appendChild(el('p', { className: 'bw-times-prompt' }, [LABELS.pickADate]));
      return panel;
    }

    const dateObj = parseDateKey(state.selectedDate);
    const headerText = `${LABELS.weekdaysLong[dateObj.getDay()].toUpperCase()}, ${LABELS.monthsLong[dateObj.getMonth()].toUpperCase()} ${dateObj.getDate()}`;
    panel.appendChild(el('h3', { className: 'bw-times-date' }, [headerText]));

    const tzName = humanTimezoneLabel();
    panel.appendChild(
      el('p', { className: 'bw-times-tz' }, [LABELS.timesShownIn.replace('{tz}', tzName)])
    );

    const slots = state.slots[state.selectedDate] ?? [];
    if (slots.length === 0) {
      panel.appendChild(el('p', { className: 'bw-times-empty' }, [LABELS.noTimesForDate]));
      return panel;
    }

    const grid = el('div', { className: 'bw-times-grid' });
    for (const iso of slots) {
      const isSelected = state.selectedTime === iso;
      const btn = el(
        'button',
        {
          type: 'button',
          className: `bw-time-btn${isSelected ? ' bw-time-selected' : ''}`,
        },
        [formatLocalTime(new Date(iso))]
      );
      btn.addEventListener('click', () => selectTime(iso));
      grid.appendChild(btn);
    }
    panel.appendChild(grid);

    if (state.selectedTime) {
      const continueBtn = el(
        'button',
        { type: 'button', className: 'bw-primary-btn bw-mt-16' },
        [LABELS.continueButton]
      );
      continueBtn.addEventListener('click', () => goToStep(2));
      panel.appendChild(continueBtn);
    }

    return panel;
  }

  // ------------------------------------------------------------------------
  // Step 2: Contact info
  // ------------------------------------------------------------------------

  function renderStep2(): HTMLElement {
    const wrap = el('div', { className: 'bw-step2' });

    wrap.appendChild(el('h3', { className: 'bw-section-heading' }, ['Your Information']));

    const form = el('form', { className: 'bw-form', noValidate: 'true' });

    form.appendChild(twoCol([
      textField('firstName', LABELS.fields.firstName, true),
      textField('lastName', LABELS.fields.lastName, true),
    ]));
    form.appendChild(textField('email', LABELS.fields.email, true, 'email'));
    form.appendChild(twoCol([
      textField('company', LABELS.fields.company, false),
      textField('phone', LABELS.fields.phone, false, 'tel'),
    ]));
    form.appendChild(textareaField('notes', LABELS.fields.notes, false));

    // Hidden honeypot. CSS makes it visually hidden but bots crawl the DOM.
    const honeypotWrap = el('div', { className: 'bw-honeypot', 'aria-hidden': 'true' });
    const honeypot = el('input', {
      type: 'text',
      name: 'website',
      autocomplete: 'off',
      tabindex: '-1',
    }) as HTMLInputElement;
    honeypotWrap.appendChild(honeypot);
    form.appendChild(honeypotWrap);

    // Buttons
    const btnRow = el('div', { className: 'bw-button-row' });
    const backBtn = el('button', { type: 'button', className: 'bw-secondary-btn' }, [LABELS.backButton]);
    backBtn.addEventListener('click', () => goToStep(1));
    const continueBtn = el('button', { type: 'submit', className: 'bw-primary-btn' }, [LABELS.continueButton]);
    btnRow.appendChild(backBtn);
    btnRow.appendChild(continueBtn);
    form.appendChild(btnRow);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (validateContactForm()) {
        goToStep(3);
      }
    });

    wrap.appendChild(form);
    return wrap;
  }

  function textField(
    name: keyof FormFields,
    label: string,
    required: boolean,
    inputType: string = 'text'
  ): HTMLElement {
    const wrap = el('div', { className: 'bw-field' });
    const labelEl = el('label', { for: `bw-input-${name}` }, [
      label,
      required
        ? el('span', { className: 'bw-required-mark', 'aria-label': LABELS.required }, [' *'])
        : (document.createTextNode('') as unknown as Node),
    ]);
    wrap.appendChild(labelEl);
    const input = el('input', {
      id: `bw-input-${name}`,
      name,
      type: inputType,
      autocomplete: autocompleteHint(name),
      ...(required ? { required: 'true' } : {}),
    }) as HTMLInputElement;
    input.value = state.form[name];
    input.addEventListener('input', () => {
      state.form[name] = input.value;
    });
    wrap.appendChild(input);
    return wrap;
  }

  function textareaField(name: keyof FormFields, label: string, required: boolean): HTMLElement {
    const wrap = el('div', { className: 'bw-field' });
    const labelEl = el('label', { for: `bw-input-${name}` }, [
      label,
      required
        ? el('span', { className: 'bw-required-mark', 'aria-label': LABELS.required }, [' *'])
        : (document.createTextNode('') as unknown as Node),
    ]);
    wrap.appendChild(labelEl);
    const ta = el('textarea', {
      id: `bw-input-${name}`,
      name,
      rows: '4',
      ...(required ? { required: 'true' } : {}),
    }) as HTMLTextAreaElement;
    ta.value = state.form[name];
    ta.addEventListener('input', () => {
      state.form[name] = ta.value;
    });
    wrap.appendChild(ta);
    return wrap;
  }

  function autocompleteHint(name: keyof FormFields): string {
    switch (name) {
      case 'firstName': return 'given-name';
      case 'lastName':  return 'family-name';
      case 'email':     return 'email';
      case 'phone':     return 'tel';
      case 'company':   return 'organization';
      default:          return 'off';
    }
  }

  function twoCol(children: HTMLElement[]): HTMLElement {
    const row = el('div', { className: 'bw-form-row' });
    for (const child of children) row.appendChild(child);
    return row;
  }

  function validateContactForm(): boolean {
    const f = state.form;
    if (!f.firstName.trim() || !f.lastName.trim()) {
      update({ errorMessage: 'Please enter your first and last name.' });
      render();
      return false;
    }
    if (!isValidEmail(f.email)) {
      update({ errorMessage: 'Please enter a valid email address.' });
      render();
      return false;
    }
    update({ errorMessage: null });
    return true;
  }

  function isValidEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  // ------------------------------------------------------------------------
  // Step 3: Confirm
  // ------------------------------------------------------------------------

  function renderStep3(): HTMLElement {
    const wrap = el('div', { className: 'bw-step3' });
    wrap.appendChild(el('h3', { className: 'bw-section-heading' }, [LABELS.summaryHeading]));

    const summary = el('div', { className: 'bw-summary' });
    if (state.selectedTime) {
      const dt = new Date(state.selectedTime);
      summary.appendChild(summaryRow(LABELS.summaryDate, formatLocalDate(dt)));
      summary.appendChild(summaryRow(LABELS.summaryTime, `${formatLocalTime(dt)} (${humanTimezoneLabel()})`));
    }
    summary.appendChild(
      summaryRow(LABELS.summaryName, `${state.form.firstName} ${state.form.lastName}`.trim())
    );
    summary.appendChild(summaryRow(LABELS.summaryEmail, state.form.email));
    if (state.form.company.trim()) {
      summary.appendChild(summaryRow(LABELS.summaryCompany, state.form.company));
    }
    wrap.appendChild(summary);

    const btnRow = el('div', { className: 'bw-button-row' });
    const backBtn = el(
      'button',
      { type: 'button', className: 'bw-secondary-btn' },
      [LABELS.backButton]
    );
    backBtn.addEventListener('click', () => goToStep(2));
    const confirmBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-primary-btn',
        ...(state.isSubmitting ? { disabled: 'true' } : {}),
      },
      [state.isSubmitting ? LABELS.submittingButton : LABELS.confirmButton]
    );
    confirmBtn.addEventListener('click', () => void submitBooking());
    btnRow.appendChild(backBtn);
    btnRow.appendChild(confirmBtn);
    wrap.appendChild(btnRow);

    return wrap;
  }

  function summaryRow(label: string, value: string): HTMLElement {
    return el('div', { className: 'bw-summary-row' }, [
      el('span', { className: 'bw-summary-label' }, [label]),
      el('span', { className: 'bw-summary-value' }, [value]),
    ]);
  }

  // ------------------------------------------------------------------------
  // Step 4: Success
  // ------------------------------------------------------------------------

  function renderStep4(): HTMLElement {
    const wrap = el('div', { className: 'bw-step4' });
    wrap.appendChild(
      el('div', { className: 'bw-success-icon', 'aria-hidden': 'true' }, ['✓'])
    );
    wrap.appendChild(el('h3', { className: 'bw-success-title' }, [LABELS.successTitle]));

    if (state.selectedTime) {
      const dt = new Date(state.selectedTime);
      wrap.appendChild(
        el('p', { className: 'bw-success-when' }, [
          `${formatLocalDate(dt)} at ${formatLocalTime(dt)} (${humanTimezoneLabel()})`,
        ])
      );
    }
    wrap.appendChild(el('p', { className: 'bw-success-subtitle' }, [LABELS.successSubtitle]));

    if (state.successJoinUrl) {
      const linkP = el('p', { className: 'bw-success-link' }, [LABELS.successJoinPrefix]);
      const a = el(
        'a',
        { href: state.successJoinUrl, target: '_blank', rel: 'noopener noreferrer' },
        ['Join Microsoft Teams meeting']
      );
      linkP.appendChild(a);
      wrap.appendChild(linkP);
    }
    return wrap;
  }

  // ------------------------------------------------------------------------
  // Navigation and selection
  // ------------------------------------------------------------------------

  function navigateMonth(delta: number): void {
    let newMonth = state.calMonth + delta;
    let newYear = state.calYear;
    while (newMonth < 0) {
      newMonth += 12;
      newYear -= 1;
    }
    while (newMonth > 11) {
      newMonth -= 12;
      newYear += 1;
    }
    update({ calMonth: newMonth, calYear: newYear });
    render();
  }

  function selectDate(dateKey: string): void {
    update({ selectedDate: dateKey, selectedTime: null });
    render();
  }

  function selectTime(iso: string): void {
    update({ selectedTime: iso });
    render();
  }

  function goToStep(step: Step): void {
    update({ step, errorMessage: null });
    render();
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  function detectTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  function humanTimezoneLabel(): string {
    try {
      const dt = new Date();
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZoneName: 'long',
      }).formatToParts(dt);
      const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
      return tzPart ?? detectTimezone();
    } catch {
      return detectTimezone();
    }
  }

  function formatDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseDateKey(key: string): Date {
    const [y, m, d] = key.split('-').map((s) => parseInt(s, 10));
    return new Date(y, m - 1, d);
  }

  function formatLocalTime(dt: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(dt);
  }

  function formatLocalDate(dt: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(dt);
  }

  function findOwnScript(): HTMLScriptElement | null {
    // Fallback when document.currentScript is unavailable (e.g. in some
    // module-loader environments). Looks for a <script> tag whose src
    // points at a /bookingwidget.js path.
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src;
      if (src && /\/bookingwidget\.js(\?|$)/.test(src)) {
        return scripts[i];
      }
    }
    return null;
  }

  type AttrValue = string | number | boolean | null | undefined;

  /**
   * Lightweight createElement helper. Pass attributes by name; `className`
   * sets the className property; everything else is set via setAttribute.
   * Children are appended in order; strings become text nodes.
   */
  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Record<string, AttrValue>,
    children?: Array<Node | string>
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'className') {
          node.className = String(v);
        } else if (k === 'noValidate' || k === 'required' || k === 'disabled') {
          if (v) node.setAttribute(k.toLowerCase(), '');
        } else if (k === 'for') {
          node.setAttribute('for', String(v));
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (children) {
      for (const child of children) {
        if (typeof child === 'string') {
          node.appendChild(document.createTextNode(child));
        } else if (child instanceof Node) {
          node.appendChild(child);
        }
      }
    }
    return node;
  }
})();
