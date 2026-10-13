/**
 * Tax deadline reminders, with a web dashboard for configuration.
 *
 * Covers three kinds of deadline:
 *   - estimated tax instalments (federal, quarterly)
 *   - sales & use tax returns (Texas, monthly/quarterly/annual)
 *   - annual returns and their extended deadlines (personal, business,
 *     Texas franchise)
 *
 * Setup
 *   1. script.google.com -> New project. Paste this as Code.gs.
 *   2. Add an HTML file named exactly "Dashboard", paste Dashboard.html in.
 *   3. Project Settings -> timezone America/Chicago.
 *   4. Run setup() once, approve the permission prompt.
 *   5. Deploy -> New deployment -> Web app.
 *        Execute as: Me      Who has access: Only myself
 *
 * Settings live in Script Properties, so redeploying will not clobber them.
 */

const DEFAULTS = {
  // Every address here gets every reminder. Empty means "the account running
  // the script"; that account is always included, so anything listed here is
  // in addition to it.
  notifyEmails: [],
  // Hard cap on recipients, mostly to keep one typo from eating the daily
  // MailApp quota (each recipient counts toward it separately).
  maxRecipients: 10,
  leadDays: [21, 7, 3, 0],
  addCalendarEvents: true,
  dailyCheckHour: 7,
  calendarMonths: 12,         // how far the dashboard preview looks ahead
  federal: {
    enabled: true,
    entity: 'Datum Geological',
    schedule: 'individual',
  },
  texas: {
    enabled: true,
    entity: 'Elay Collective',
    frequency: 'quarterly',
  },
  returns: {
    personal: { enabled: true, label: 'Personal', remindExtended: true },
    businesses: [
      { id: 'biz1', enabled: true, label: 'Datum Geological',
        entityType: 'partnership', remindExtended: true },
    ],
    // Off by default: below the no-tax-due threshold there is generally no
    // franchise report to file. Switch on if revenue crosses it.
    franchise: { enabled: false, label: 'Elay Collective', remindExtended: true },
  },
};

/**
 * Federal estimated tax instalments. Individuals pay on uneven periods; a
 * calendar-year C corp pays on the 15th of the 4th, 6th, 9th and 12th months,
 * which moves the last instalment from January back into December.
 */
const FEDERAL_SCHEDULES = {
  individual: {
    label: 'Individual / pass-through (Form 1040-ES)',
    form: 'Form 1040-ES',
    payUrl: 'https://www.irs.gov/payments/direct-pay',
    periods: [
      { key: 'q1', label: 'Q1', month: 3,  day: 15, period: 'Jan 1 – Mar 31, {year}', yearOffset: 0 },
      { key: 'q2', label: 'Q2', month: 5,  day: 15, period: 'Apr 1 – May 31, {year}', yearOffset: 0 },
      { key: 'q3', label: 'Q3', month: 8,  day: 15, period: 'Jun 1 – Aug 31, {year}', yearOffset: 0 },
      { key: 'q4', label: 'Q4', month: 0,  day: 15, period: 'Sep 1 – Dec 31, {year}', yearOffset: -1 },
    ],
  },
  corporate: {
    label: 'C corporation (Form 1120-W)',
    form: 'Form 1120-W',
    payUrl: 'https://www.eftps.gov',
    periods: [
      { key: 'q1', label: 'Q1', month: 3,  day: 15, period: 'Jan 1 – Mar 31, {year}', yearOffset: 0 },
      { key: 'q2', label: 'Q2', month: 5,  day: 15, period: 'Apr 1 – May 31, {year}', yearOffset: 0 },
      { key: 'q3', label: 'Q3', month: 8,  day: 15, period: 'Jun 1 – Aug 31, {year}', yearOffset: 0 },
      { key: 'q4', label: 'Q4', month: 11, day: 15, period: 'Sep 1 – Dec 31, {year}', yearOffset: 0 },
    ],
  },
};

const TEXAS = {
  form: 'Comptroller Webfile',
  payUrl: 'https://comptroller.texas.gov/taxes/file-pay/',
  note: 'Late returns take a flat $50 penalty plus 5% of tax due, ' +
        'stepping up to 10% after 30 days.',
  frequencies: {
    monthly:   'Monthly — 20th of the following month',
    quarterly: 'Quarterly — Apr 20 / Jul 20 / Oct 20 / Jan 20',
    annual:    'Annual — Jan 20',
  },
};

/**
 * Annual returns. The original due date doubles as the extension-request
 * deadline, so each of these produces at most two dated reminders: file-or-
 * extend, and the extended deadline.
 */
const PERSONAL_RETURN = {
  form: 'Form 1040',
  extensionForm: 'Form 4868',
  federal: true,
  payUrl: 'https://www.irs.gov/filing',
  period: 'Tax year {year}',
  yearOffset: -1,
  due: { month: 3, day: 15 },
  extended: { month: 9, day: 15 },
};

/**
 * Business returns collapse onto three date sets. The LLC variants are listed
 * separately because that is how the entities are usually described, but an
 * LLC taxed as an S corp files the same form on the same dates as any other
 * S corp.
 *
 * Statutory dates only — the observed date is computed, so the March 15 group
 * lands on March 16 in 2026 (the 15th is a Sunday) and back on March 15 in
 * 2027 without anything here changing.
 */
const BUSINESS_TYPES = {
  partnership: {
    label: 'Partnership / multi-member LLC (Form 1065)',
    form: 'Form 1065',
    extensionForm: 'Form 7004',
    federal: true,
    payUrl: 'https://www.irs.gov/filing',
    period: 'Tax year {year}',
    yearOffset: -1,
    due: { month: 2, day: 15 },
    extended: { month: 8, day: 15 },
  },
  scorp: {
    label: 'S corporation, incl. LLC taxed as S corp (Form 1120-S)',
    form: 'Form 1120-S',
    extensionForm: 'Form 7004',
    federal: true,
    payUrl: 'https://www.irs.gov/filing',
    period: 'Tax year {year}',
    yearOffset: -1,
    due: { month: 2, day: 15 },
    extended: { month: 8, day: 15 },
  },
  ccorp: {
    label: 'C corporation, incl. LLC taxed as C corp (Form 1120)',
    form: 'Form 1120',
    extensionForm: 'Form 7004',
    federal: true,
    payUrl: 'https://www.irs.gov/filing',
    period: 'Tax year {year}',
    yearOffset: -1,
    due: { month: 3, day: 15 },
    extended: { month: 9, day: 15 },
  },
  soleprop: {
    // Rides on the personal 1040, so switch this on only if you want the
    // business called out by name alongside the personal reminder.
    label: 'Sole proprietor / single-member LLC (Schedule C)',
    form: 'Schedule C',
    extensionForm: 'Form 4868',
    federal: true,
    payUrl: 'https://www.irs.gov/filing',
    period: 'Tax year {year}',
    yearOffset: -1,
    due: { month: 3, day: 15 },
    extended: { month: 9, day: 15 },
  },
};

const FRANCHISE_RETURN = {
  form: 'Texas franchise tax report',
  extensionForm: 'extension request',
  federal: false,               // state deadline: Emancipation Day does not apply
  payUrl: 'https://comptroller.texas.gov/taxes/franchise/',
  period: 'Report year {year}',
  yearOffset: 0,
  due: { month: 4, day: 15 },
  extended: { month: 10, day: 15 },
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LAST_DAY = [31, 31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Lead times offered on the dashboard, in days before the deadline. */
const LEAD_CHOICES = [60, 30, 21, 14, 7, 3, 1, 0];

/** How many months of calendar the dashboard can draw. */
const CALENDAR_RANGES = [6, 12, 18, 24];
const DEFAULT_CALENDAR_MONTHS = 12;

// ------------------------------------------------------------------ web app

function doGet() {
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('Tax deadline reminders')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Everything the dashboard needs to render, in one round trip. */
function loadDashboard() {
  const settings = getSettings();
  return {
    settings: settings,
    defaultEmail: Session.getEffectiveUser().getEmail(),
    timezone: tz(),
    triggerInstalled: hasTrigger(),
    federalSchedules: Object.keys(FEDERAL_SCHEDULES).map(function (k) {
      return { value: k, label: FEDERAL_SCHEDULES[k].label };
    }),
    texasFrequencies: Object.keys(TEXAS.frequencies).map(function (k) {
      return { value: k, label: TEXAS.frequencies[k] };
    }),
    businessTypes: Object.keys(BUSINESS_TYPES).map(function (k) {
      return { value: k, label: BUSINESS_TYPES[k].label };
    }),
    leadChoices: LEAD_CHOICES,
    calendarRanges: CALENDAR_RANGES,
    preview: previewFor(settings, 24),
  };
}

/** Recomputes the preview without saving, so the dashboard can show edits live. */
function previewSettings(settings) {
  return previewFor(normalize(settings), 24);
}

function saveSettings(raw) {
  const settings = normalize(raw);
  PropertiesService.getScriptProperties()
    .setProperty('settings', JSON.stringify(settings));

  installTrigger(settings.dailyCheckHour);
  resyncCalendar();

  return { settings: settings, preview: previewFor(settings, 24) };
}

function sendTestEmail() {
  const settings = getSettings();
  const next = upcomingDeadlines(startOfDay(new Date()), 2, settings)[0];
  if (!next) throw new Error('Nothing scheduled — everything is switched off.');

  sendReminder(next, daysBetween(startOfDay(new Date()), next.due), settings, true);
  return 'Test sent to ' + recipients(settings).join(', ');
}

// --------------------------------------------------------------- entry points

function setup() {
  const settings = getSettings();
  installTrigger(settings.dailyCheckHour);
  resyncCalendar();
  previewFor(settings, 12).schedule.forEach(function (d) {
    Logger.log('%s  %s — %s', d.dueText, d.entity, d.title);
  });
}

function checkDeadlines() {
  const settings = getSettings();
  const props = PropertiesService.getScriptProperties();
  const today = startOfDay(new Date());

  upcomingDeadlines(today, 2, settings).forEach(function (dl) {
    const daysOut = daysBetween(today, dl.due);
    if (daysOut < 0) return;

    const crossed = settings.leadDays.filter(function (lead) {
      return daysOut <= lead;
    });
    const unsent = crossed.filter(function (lead) {
      return !props.getProperty(sentKey(dl, lead));
    });
    if (!unsent.length) return;

    sendReminder(dl, daysOut, settings, false);
    const stamp = new Date().toISOString();
    unsent.forEach(function (lead) {
      props.setProperty(sentKey(dl, lead), stamp);
    });
  });

  topUpCalendar(settings);
  pruneOldKeys(props, today);
}

/**
 * Drops every calendar event this script owns and rebuilds from current
 * settings. Called on save, since changing an entity type or filing frequency
 * invalidates whatever was already on the calendar.
 */
function resyncCalendar() {
  const props = PropertiesService.getScriptProperties();
  const settings = getSettings();
  const cal = CalendarApp.getDefaultCalendar();

  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('cal:') !== 0) return;
    try {
      const event = cal.getEventById(props.getProperty(k));
      if (event && event.getAllDayStartDate() >= startOfDay(new Date())) {
        event.deleteEvent();
      }
    } catch (e) {
      // Already removed by hand; dropping the property below is enough.
    }
    props.deleteProperty(k);
  });

  if (!settings.addCalendarEvents) return;

  upcomingDeadlines(startOfDay(new Date()), 2, settings).forEach(function (dl) {
    props.setProperty('cal:' + dl.key + ':' + dl.dueYear,
                      createDeadlineEvent(cal, dl).getId());
  });
}

/**
 * Creates events for upcoming deadlines that do not have one yet, without
 * deleting anything. This is what keeps the calendar populated as time rolls
 * forward: resyncCalendar only runs on save, so without this the events would
 * stop about two years after the last time settings were touched.
 */
function topUpCalendar(settings) {
  if (!settings.addCalendarEvents) return;

  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperties();
  const missing = upcomingDeadlines(startOfDay(new Date()), 2, settings)
    .filter(function (dl) {
      return !stored['cal:' + dl.key + ':' + dl.dueYear];
    });
  if (!missing.length) return;      // avoid touching Calendar on the usual day

  const cal = CalendarApp.getDefaultCalendar();
  missing.forEach(function (dl) {
    props.setProperty('cal:' + dl.key + ':' + dl.dueYear,
                      createDeadlineEvent(cal, dl).getId());
  });
}

function createDeadlineEvent(cal, dl) {
  const event = cal.createAllDayEvent(
    dl.entity + ': ' + dl.title,
    dl.due,
    { description: describe(dl) });
  // All-day reminders count backward from midnight of the due date, not from a
  // wall-clock time, so these are 9 AM the day before and 9 AM three days before.
  event.addPopupReminder(15 * 60);
  event.addPopupReminder(3 * 24 * 60 - 9 * 60);
  return event;
}

// ------------------------------------------------------------------ reminders

function sendReminder(dl, daysOut, settings, isTest) {
  const when = daysOut === 0 ? 'TODAY'
    : daysOut === 1 ? 'tomorrow'
    : 'in ' + daysOut + ' days';

  MailApp.sendEmail({
    to: recipients(settings).join(','),
    subject: (isTest ? '[test] ' : '') +
             '[' + dl.entity + '] ' + dl.title + ' ' + when +
             ' — ' + Utilities.formatDate(dl.due, tz(), 'EEE MMM d'),
    body: describe(dl) + '\n\nDue ' + when + '.\n' +
          (isTest ? '\n(This was a test from the dashboard.)\n' : ''),
  });
}

function describe(dl) {
  return [
    'Entity:      ' + dl.entity,
    'Filing:      ' + dl.title,
    'Period:      ' + dl.periodText,
    'Due:         ' + Utilities.formatDate(dl.due, tz(), 'EEEE, MMMM d, yyyy'),
    'File / pay:  ' + dl.payUrl,
    '',
    dl.note,
  ].join('\n');
}

/**
 * The account running the script always hears about deadlines; the configured
 * addresses are added to it rather than replacing it.
 */
function recipients(settings) {
  const me = Session.getEffectiveUser().getEmail();
  const extra = settings.notifyEmails.filter(function (e) {
    return e.toLowerCase() !== me.toLowerCase();
  });
  return [me].concat(extra);
}

// -------------------------------------------------------------------- settings

function getSettings() {
  const stored = PropertiesService.getScriptProperties().getProperty('settings');
  return normalize(stored ? JSON.parse(stored) : {});
}

/** Fills in defaults and clamps anything the dashboard could send in wrong. */
function normalize(raw) {
  const s = raw || {};
  const fed = s.federal || {};
  const tex = s.texas || {};
  const ret = s.returns || {};

  var leads = (s.leadDays || DEFAULTS.leadDays)
    .map(Number)
    .filter(function (n) { return isFinite(n) && n >= 0 && n <= 180; });
  leads = leads.filter(function (n, i, a) { return a.indexOf(n) === i; })
               .sort(function (a, b) { return b - a; });
  if (!leads.length) leads = DEFAULTS.leadDays.slice();

  return {
    // Settings saved before this was a list stored a single `notifyEmail`
    // string; normalizeEmails accepts either shape.
    notifyEmails: normalizeEmails(
      s.notifyEmails !== undefined ? s.notifyEmails : s.notifyEmail),
    leadDays: leads,
    addCalendarEvents: s.addCalendarEvents !== false,
    dailyCheckHour: clamp(Number(s.dailyCheckHour) || DEFAULTS.dailyCheckHour, 0, 23),
    calendarMonths: CALENDAR_RANGES.indexOf(Number(s.calendarMonths)) >= 0
      ? Number(s.calendarMonths) : DEFAULT_CALENDAR_MONTHS,
    federal: {
      enabled: fed.enabled !== false,
      entity: (fed.entity || DEFAULTS.federal.entity).trim(),
      schedule: FEDERAL_SCHEDULES[fed.schedule] ? fed.schedule : DEFAULTS.federal.schedule,
    },
    texas: {
      enabled: tex.enabled !== false,
      entity: (tex.entity || DEFAULTS.texas.entity).trim(),
      frequency: TEXAS.frequencies[tex.frequency] ? tex.frequency : DEFAULTS.texas.frequency,
    },
    returns: {
      personal: normalizeReturn(ret.personal, DEFAULTS.returns.personal),
      businesses: normalizeBusinesses(ret.businesses),
      franchise: normalizeReturn(ret.franchise, DEFAULTS.returns.franchise),
    },
  };
}

/**
 * Absent keys fall back to DEFAULTS rather than to true, so a default of
 * "off" survives settings saved before this section existed.
 */
function normalizeReturn(raw, fallback) {
  const r = raw || {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled,
    label: (r.label || fallback.label).trim(),
    remindExtended: typeof r.remindExtended === 'boolean'
      ? r.remindExtended : fallback.remindExtended,
  };
}

/**
 * Accepts an array or a string of addresses separated by commas, semicolons,
 * whitespace or newlines. Drops blanks, anything that is not shaped like an
 * address, and case-insensitive duplicates. Order is preserved.
 */
function normalizeEmails(raw) {
  var list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
  const seen = {};

  return list
    .map(function (e) { return String(e || '').trim(); })
    .filter(function (e) {
      if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
      const k = e.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    })
    .slice(0, DEFAULTS.maxRecipients);
}

function normalizeBusinesses(raw) {
  const list = Array.isArray(raw) ? raw : DEFAULTS.returns.businesses;
  const seen = {};

  return list.map(function (b, i) {
    // Ids key the sent-records and calendar events, so they must be stable and
    // unique even if the dashboard sends something odd.
    var id = String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || seen[id]) id = 'biz' + (i + 1);
    seen[id] = true;

    return {
      id: id,
      enabled: b.enabled !== false,
      label: (b.label || 'Business ' + (i + 1)).trim(),
      entityType: BUSINESS_TYPES[b.entityType] ? b.entityType : 'partnership',
      remindExtended: b.remindExtended !== false,
    };
  }).slice(0, 8);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ------------------------------------------------------------ deadline engine

/** Every deadline from `from` through `years` out, in date order. */
function upcomingDeadlines(from, years, settings) {
  const out = [];
  const specs = specsForYear(settings);

  for (var y = from.getFullYear(); y <= from.getFullYear() + years; y++) {
    specs.forEach(function (spec) {
      const statutory = new Date(y, spec.month, spec.day);
      const due = observedDueDate(statutory, spec.federal);
      if (due < from) return;
      out.push({
        key: spec.key,
        entity: spec.entity,
        title: spec.title,
        form: spec.form,
        federal: spec.federal,
        annual: !!spec.annual,
        note: spec.note,
        payUrl: spec.payUrl,
        due: due,
        statutory: statutory,
        dueYear: y,
        periodText: spec.period.replace('{year}', y + spec.yearOffset),
      });
    });
  }
  return out.sort(function (a, b) { return a.due - b.due; });
}

/** The shape of one year, given what is switched on and how each entity files. */
function specsForYear(settings) {
  const specs = [];

  if (settings.federal.enabled) {
    const sched = FEDERAL_SCHEDULES[settings.federal.schedule];
    sched.periods.forEach(function (p) {
      specs.push({
        key: 'fed-' + p.key,
        entity: settings.federal.entity,
        title: 'Federal estimated tax ' + p.label,
        form: sched.form,
        payUrl: sched.payUrl,
        federal: true,
        month: p.month, day: p.day,
        period: p.period, yearOffset: p.yearOffset,
        note: sched.form + '. Underpayment interest accrues from the due date.',
      });
    });
  }

  if (settings.texas.enabled) {
    texasPeriods(settings.texas.frequency).forEach(function (p) {
      specs.push({
        key: 'tx-' + p.key,
        entity: settings.texas.entity,
        title: 'Texas sales & use tax ' + p.label,
        form: TEXAS.form,
        payUrl: TEXAS.payUrl,
        federal: false,
        month: p.month, day: p.day,
        period: p.period, yearOffset: p.yearOffset,
        note: TEXAS.note,
      });
    });
  }

  const r = settings.returns;
  if (r.personal.enabled) {
    pushReturn(specs, 'ret-personal', r.personal, PERSONAL_RETURN);
  }
  r.businesses.forEach(function (b) {
    if (b.enabled) pushReturn(specs, 'ret-' + b.id, b, BUSINESS_TYPES[b.entityType]);
  });
  if (r.franchise.enabled) {
    pushReturn(specs, 'ret-franchise', r.franchise, FRANCHISE_RETURN);
  }

  return specs;
}

/**
 * Turns one annual return into its dated reminders. The original due date is
 * also the last day to request an extension, so it gets a combined label
 * rather than two separate entries on the same day.
 */
function pushReturn(specs, key, cfg, type) {
  const base = {
    entity: cfg.label,
    form: type.form,
    payUrl: type.payUrl,
    federal: type.federal,
    annual: true,
    period: type.period,
    yearOffset: type.yearOffset,
  };

  specs.push(Object.assign({}, base, {
    key: key + '-due',
    title: type.form + ' due — file or extend',
    month: type.due.month, day: type.due.day,
    note: 'File ' + type.form + ', or file ' + type.extensionForm +
          ' by today to extend.\n' +
          'An extension extends the time to FILE, not the time to PAY. ' +
          'Anything owed is still due today or it starts accruing ' +
          'penalty and interest.',
  }));

  if (cfg.remindExtended) {
    specs.push(Object.assign({}, base, {
      key: key + '-ext',
      title: type.form + ' due (extended)',
      month: type.extended.month, day: type.extended.day,
      note: 'Extended deadline for ' + type.form + '. ' +
            'No further extension is available.',
    }));
  }
}

/**
 * Texas sales tax returns are always due the 20th; only the reporting period
 * changes. The January deadline always reports on the prior calendar year.
 */
function texasPeriods(frequency) {
  if (frequency === 'annual') {
    return [{ key: 'annual', label: '(annual)', month: 0, day: 20,
              period: 'Jan 1 – Dec 31, {year}', yearOffset: -1 }];
  }

  if (frequency === 'monthly') {
    return MONTH_NAMES.map(function (_, dueMonth) {
      const reported = (dueMonth + 11) % 12;
      return {
        key: 'm' + reported,
        label: '(' + MONTH_NAMES[reported] + ')',
        month: dueMonth,
        day: 20,
        period: MONTH_NAMES[reported] + ' 1 – ' + MONTH_NAMES[reported] + ' ' +
                MONTH_LAST_DAY[reported] + ', {year}',
        yearOffset: dueMonth === 0 ? -1 : 0,
      };
    });
  }

  return [
    { key: 'q4', label: 'Q4', month: 0, day: 20, period: 'Oct 1 – Dec 31, {year}', yearOffset: -1 },
    { key: 'q1', label: 'Q1', month: 3, day: 20, period: 'Jan 1 – Mar 31, {year}', yearOffset: 0 },
    { key: 'q2', label: 'Q2', month: 6, day: 20, period: 'Apr 1 – Jun 30, {year}', yearOffset: 0 },
    { key: 'q3', label: 'Q3', month: 9, day: 20, period: 'Jul 1 – Sep 30, {year}', yearOffset: 0 },
  ];
}

/**
 * One payload driving both dashboard previews: the upcoming list and the
 * calendar grid. Both come from the same computation so they cannot disagree.
 */
function previewFor(settings, count) {
  const today = startOfDay(new Date());
  // Look far enough ahead to fill the calendar even at its widest setting.
  const deadlines = upcomingDeadlines(today, 3, settings);

  return {
    schedule: deadlines.slice(0, count).map(function (d) {
      return {
        entity: d.entity,
        title: d.title,
        period: d.periodText,
        federal: d.federal,
        annual: d.annual,
        dueText: Utilities.formatDate(d.due, tz(), 'EEE MMM d, yyyy'),
        daysOut: daysBetween(today, d.due),
        // True when a weekend or holiday pushed the date off the statutory
        // day, so a shifted date does not look like a bug.
        shifted: !sameDay(d.due, d.statutory),
        statutoryText: Utilities.formatDate(d.statutory, tz(), 'MMM d'),
      };
    }),
    calendar: calendarFeed(deadlines, settings, today),
    today: isoDate(today),
    startYear: today.getFullYear(),
    startMonth: today.getMonth(),
    monthCount: settings.calendarMonths,
  };
}

/**
 * Flat list of dated marks for the calendar: every deadline in the window,
 * plus the day each reminder email actually goes out. Past sends are omitted,
 * since the calendar is about what is still coming.
 */
function calendarFeed(deadlines, settings, today) {
  const horizon = new Date(today.getFullYear(),
                           today.getMonth() + settings.calendarMonths, 0);
  const marks = [];

  deadlines.forEach(function (dl) {
    if (dl.due > horizon) return;

    marks.push({
      date: isoDate(dl.due),
      kind: 'deadline',
      entity: dl.entity,
      title: dl.title,
      federal: dl.federal,
      annual: dl.annual,
      label: dl.entity + ' — ' + dl.title,
    });

    settings.leadDays.forEach(function (lead) {
      const send = new Date(dl.due.getTime());
      send.setDate(send.getDate() - lead);
      if (send < today) return;

      marks.push({
        date: isoDate(send),
        kind: 'alert',
        lead: lead,
        entity: dl.entity,
        title: dl.title,
        federal: dl.federal,
        annual: dl.annual,
        label: 'Email: ' + dl.entity + ' ' + dl.title + ' — ' +
               (lead === 0 ? 'due today' : lead + ' day' +
                (lead === 1 ? '' : 's') + ' out'),
      });
    });
  });

  return marks;
}

/** Date key in the script timezone, so it matches the grid the client draws. */
function isoDate(d) {
  return Utilities.formatDate(d, tz(), 'yyyy-MM-dd');
}

// -------------------------------------------------------------- date machinery

/**
 * Rolls a statutory date forward past weekends and holidays, which is why
 * these deadlines drift a day or two from year to year.
 */
function observedDueDate(date, isFederal) {
  const d = new Date(date.getTime());
  var guard = 0;
  while (isWeekend(d) || isHoliday(d, isFederal)) {
    d.setDate(d.getDate() + 1);
    if (++guard > 10) break;
  }
  return startOfDay(d);
}

function isWeekend(d) {
  return d.getDay() === 0 || d.getDay() === 6;
}

function isHoliday(d, isFederal) {
  return holidays(d.getFullYear(), isFederal).some(function (h) {
    return sameDay(h, d);
  });
}

function holidays(year, isFederal) {
  const days = [
    observedFixed(year, 0, 1),      // New Year's Day
    nthWeekday(year, 0, 1, 3),      // MLK Day
    nthWeekday(year, 1, 1, 3),      // Washington's Birthday
    lastWeekday(year, 4, 1),        // Memorial Day
    observedFixed(year, 5, 19),     // Juneteenth
    observedFixed(year, 6, 4),      // Independence Day
    nthWeekday(year, 8, 1, 1),      // Labor Day
    nthWeekday(year, 9, 1, 2),      // Columbus Day
    observedFixed(year, 10, 11),    // Veterans Day
    nthWeekday(year, 10, 4, 4),     // Thanksgiving
    observedFixed(year, 11, 25),    // Christmas
  ];
  // Emancipation Day is a DC holiday, so it moves IRS deadlines but not the
  // Comptroller's. It is why April 15 sometimes lands on the 17th or 18th.
  if (isFederal) days.push(observedFixed(year, 3, 16));
  return days;
}

function observedFixed(year, month, day) {
  const d = new Date(year, month, day);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}

/** e.g. nthWeekday(2027, 0, 1, 3) -> third Monday of January 2027. */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + shift + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0);
  const shift = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - shift);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

// ----------------------------------------------------------------- bookkeeping

function installTrigger(hour) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkDeadlines') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkDeadlines')
    .timeBased().everyDays(1).atHour(hour).create();
}

function hasTrigger() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'checkDeadlines';
  });
}

function sentKey(dl, lead) {
  return 'sent:' + dl.key + ':' + dl.dueYear + ':' + lead;
}

/**
 * Drops send-records and calendar-event ids for years that are well past, so
 * Script Properties do not grow without bound as the years roll forward.
 */
function pruneOldKeys(props, today) {
  const cutoff = today.getFullYear() - 2;
  Object.keys(props.getProperties()).forEach(function (k) {
    // sent:<deadline>:<year>:<lead>  |  cal:<deadline>:<year>
    const isSent = k.indexOf('sent:') === 0;
    const isCal = k.indexOf('cal:') === 0;
    if (!isSent && !isCal) return;
    if (Number(k.split(':')[2]) < cutoff) props.deleteProperty(k);
  });
}

function tz() {
  return Session.getScriptTimeZone();
}
