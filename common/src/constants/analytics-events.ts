/**
 * Enum of analytics event types used throughout the application
 */
export enum AnalyticsEvent {
  // Cross-surface — DAU
  // Emitted exactly once per user-submitted message/prompt, on each surface,
  // and never sampled. `distinct_id` is the canonical codebuff Postgres user
  // id on every surface, so unique-users of this event gives accurate
  // per-surface DAU (filter on the `surface` property) and a combined DAU (no
  // filter). The `surface` property is one of: cli, web, chat, desktop, cloud
  // (web = the freebuff.com builder, cloud = connected-repo builder projects).
  // Emission points: cli client analytics; chat's stream route (server-side);
  // desktop's analytics module; web/cloud via the Convex send mutation
  // (PostHog + Axiom, both direct from Convex — see convex/analytics.ts).
  MESSAGE_SENT = 'message_sent',

  // Cross-surface — engaged time
  // Emitted once per minute of *active engagement* on each surface (cli / web /
  // chat / cloud / desktop) while the user is present (visible+focused for
  // browser surfaces, recently-active for the CLI) and not idle. Never sampled.
  // `distinct_id` is the canonical user id where available (anonymous/device id
  // otherwise). Because interval = 1 minute, a raw event COUNT equals minutes
  // spent: sum per product = Total count broken down by `surface`; average per
  // user = "Average count per user" broken down by `surface`. See
  // common/src/util/engagement-tracker.ts.
  PRODUCT_ACTIVE_MINUTE = 'product_active_minute',

  // CLI
  APP_LAUNCHED = 'cli.app_launched',
  FINGERPRINT_GENERATED = 'cli.fingerprint_generated',
  CHANGE_DIRECTORY = 'cli.change_directory',
  INVALID_COMMAND = 'cli.invalid_command',
  KNOWLEDGE_FILE_UPDATED = 'cli.knowledge_file_updated',
  LOGIN = 'cli.login',
  // Login funnel — the path between launch and a successful `cli.login`.
  // Emitted from login-flow.ts (the chokepoint both the modal and the
  // `login` command share); all tagged with `via` (modal | plain_command).
  LOGIN_STARTED = 'cli.login_started',
  LOGIN_FAILED = 'cli.login_failed',
  LOGIN_TIMEOUT = 'cli.login_timeout',
  LOGIN_ABORTED = 'cli.login_aborted',
  ACCOUNT_SWITCH_BLOCKED = 'cli.account_switch_blocked',
  SLASH_MENU_ACTIVATED = 'cli.slash_menu_activated',
  SLASH_COMMAND_USED = 'cli.slash_command_used',
  TERMINAL_BROKER_SPAWN_FAILED = 'cli.terminal_broker_spawn_failed',
  TERMINAL_WATCHDOG_FAILED = 'cli.terminal_watchdog_failed',
  TERMINAL_COMMAND_COMPLETED = 'cli.terminal_command_completed',
  UPDATE_CODEBUFF_FAILED = 'cli.update_codebuff_failed',
  FEEDBACK_BUTTON_HOVERED = 'cli.feedback_button_hovered',
  FOLLOWUP_CLICKED = 'cli.followup_clicked',
  SUGGESTED_PROMPT_SHOWN = 'cli.suggested_prompt_shown',
  SUGGESTED_PROMPT_CLICKED = 'cli.suggested_prompt_clicked',
  // Sampled per eligible transcript slot; use response_id to recover the
  // response-length distribution without ingesting every user's full stream.
  CLI_INLINE_AD_SLOT_ELIGIBLE = 'cli.inline_ad_slot_eligible',
  // Backend
  CREDIT_GRANT = 'backend.credit_grant',
  CREDIT_CONSUMED = 'backend.credit_consumed',
  MALFORMED_TOOL_CALL_JSON = 'backend.malformed_tool_call_json',
  UNKNOWN_TOOL_CALL = 'backend.unknown_tool_call',

  // Backend - Database Operations
  ADVISORY_LOCK_CONTENTION = 'backend.advisory_lock_contention',
  TRANSACTION_RETRY_THRESHOLD_EXCEEDED = 'backend.transaction_retry_threshold_exceeded',

  // Backend - Subscription
  SUBSCRIPTION_CREATED = 'backend.subscription_created',
  SUBSCRIPTION_CANCELED = 'backend.subscription_canceled',
  SUBSCRIPTION_PAYMENT_FAILED = 'backend.subscription_payment_failed',
  SUBSCRIPTION_BLOCK_CREATED = 'backend.subscription_block_created',
  SUBSCRIPTION_BLOCK_LIMIT_HIT = 'backend.subscription_block_limit_hit',
  SUBSCRIPTION_WEEKLY_LIMIT_HIT = 'backend.subscription_weekly_limit_hit',
  SUBSCRIPTION_CREDITS_MIGRATED = 'backend.subscription_credits_migrated',
  SUBSCRIPTION_TIER_CHANGED = 'backend.subscription_tier_changed',

  // Web
  SIGNUP = 'web.signup',

  // Web - Authentication
  AUTH_LOGIN_STARTED = 'auth.login_started',
  AUTH_LOGOUT_COMPLETED = 'auth.logout_completed',

  // Web - Cookie Consent
  COOKIE_CONSENT_ACCEPTED = 'cookie_consent.accepted',
  COOKIE_CONSENT_DECLINED = 'cookie_consent.declined',

  // Web - Onboarding
  ONBOARDING_STEP_COMPLETED = 'onboarding_step_completed',
  ONBOARDING_STEP_VIEWED = 'onboarding_step_viewed',
  ONBOARDING_PM_SELECTED = 'onboarding_pm_selected',
  ONBOARDING_EDITOR_OPENED = 'onboarding_editor_opened',

  // Web - Onboard Page
  ONBOARD_PAGE_CD_COMMAND_COPIED = 'onboard_page.cd_command_copied',
  ONBOARD_PAGE_RUN_COMMAND_COPIED = 'onboard_page.run_command_copied',
  ONBOARD_PAGE_INSTALL_COMMAND_COPIED = 'onboard_page.install_command_copied',

  // Web - Creator Attribution
  CODEBUFF_REFERRER_ATTRIBUTED = 'codebuff.referrer_attributed',

  // Web - Install Dialog
  INSTALL_DIALOG_CD_COMMAND_COPIED = 'install_dialog.cd_command_copied',
  INSTALL_DIALOG_RUN_COMMAND_COPIED = 'install_dialog.run_command_copied',
  INSTALL_DIALOG_INSTALL_COMMAND_COPIED = 'install_dialog.install_command_copied',

  // Web - Home Page
  HOME_FEATURE_LEARN_MORE_CLICKED = 'home.feature_learn_more_clicked',
  HOME_INSTALL_COMMAND_COPIED = 'home.install_command_copied',
  HOME_TRY_FREE_CLICKED = 'home.try_free_clicked',
  HOME_TESTIMONIAL_CLICKED = 'home.testimonial_clicked',
  HOME_CTA_INSTALL_GUIDE_CLICKED = 'home.cta_install_guide_clicked',
  HOME_COMPETITION_TAB_CHANGED = 'home.competition_tab_changed',

  // Web - Demo Terminal
  DEMO_TERMINAL_COMMAND_EXECUTED = 'demo_terminal.command_executed',
  DEMO_TERMINAL_HELP_VIEWED = 'demo_terminal.help_viewed',
  DEMO_TERMINAL_OPTIMIZE_REQUESTED = 'demo_terminal.optimize_requested',
  DEMO_TERMINAL_FIX_MEMORY_LEAK = 'demo_terminal.fix_memory_leak',
  DEMO_TERMINAL_REFACTOR_REQUESTED = 'demo_terminal.refactor_requested',
  DEMO_TERMINAL_FEATURE_REQUESTED = 'demo_terminal.feature_requested',
  DEMO_TERMINAL_THEME_CHANGED = 'demo_terminal.theme_changed',

  // Web - UI Components
  TOAST_SHOWN = 'toast.shown',

  // Web - API
  AGENT_RUN_VALIDATION_ERROR = 'api.agent_run_validation_error',
  AGENT_RUN_CREATION_ERROR = 'api.agent_run_creation_error',
  AGENT_RUN_COMPLETION_ERROR = 'api.agent_run_completion_error',
  ME_VALIDATION_ERROR = 'api.me_validation_error',
  CHAT_COMPLETIONS_AUTH_ERROR = 'api.chat_completions_auth_error',
  CHAT_COMPLETIONS_VALIDATION_ERROR = 'api.chat_completions_validation_error',
  CHAT_COMPLETIONS_INSUFFICIENT_CREDITS = 'api.chat_completions_insufficient_credits',
  CHAT_COMPLETIONS_GENERATION_STARTED = 'api.chat_completions_generation_started',
  CHAT_COMPLETIONS_ERROR = 'api.chat_completions_error',

  // Web - Usage API
  USAGE_API_AUTH_ERROR = 'api.usage_auth_error',

  // Web - Search API
  WEB_SEARCH_AUTH_ERROR = 'api.web_search_auth_error',
  WEB_SEARCH_VALIDATION_ERROR = 'api.web_search_validation_error',
  WEB_SEARCH_INSUFFICIENT_CREDITS = 'api.web_search_insufficient_credits',
  WEB_SEARCH_ERROR = 'api.web_search_error',

  DOCS_SEARCH_REQUEST = 'api.docs_search_request',
  DOCS_SEARCH_AUTH_ERROR = 'api.docs_search_auth_error',
  DOCS_SEARCH_VALIDATION_ERROR = 'api.docs_search_validation_error',
  DOCS_SEARCH_INSUFFICIENT_CREDITS = 'api.docs_search_insufficient_credits',
  DOCS_SEARCH_ERROR = 'api.docs_search_error',

  GRAVITY_INDEX_REQUEST = 'api.gravity_index_request',
  GRAVITY_INDEX_AUTH_ERROR = 'api.gravity_index_auth_error',
  GRAVITY_INDEX_VALIDATION_ERROR = 'api.gravity_index_validation_error',
  GRAVITY_INDEX_ERROR = 'api.gravity_index_error',

  // Web - Feedback API
  FEEDBACK_SUBMITTED = 'api.feedback_submitted',
  FEEDBACK_AUTH_ERROR = 'api.feedback_auth_error',
  FEEDBACK_VALIDATION_ERROR = 'api.feedback_validation_error',

  // Web - Logs ingest API (client logs/events → BigQuery)
  LOGS_INGEST_AUTH_ERROR = 'api.logs_ingest_auth_error',
  LOGS_INGEST_VALIDATION_ERROR = 'api.logs_ingest_validation_error',

  // Web - Ads API
  ADS_API_AUTH_ERROR = 'api.ads_auth_error',
  ADS_FETCH_COMPLETED = 'ads.fetch_completed',
  ADS_IMPRESSION_RECORDED = 'ads.impression_recorded',
  ADS_CLICKED = 'ads.clicked',
  ADS_FIRST_PARTY_DECISION = 'ads.first_party_decision',
  ADS_FIRST_PARTY_SETTLEMENT = 'ads.first_party_settlement',
  ADS_FIRST_PARTY_VIEW_ACK = 'ads.first_party_view_ack',
  /**
   * The CLI dock was expanded into its detail panel (COD-457). A UI gesture,
   * NOT an impression and never billable: deduped per `impUrl` per app
   * session, so opening the same ad ten times is one expansion.
   */
  ADS_DOCK_EXPANDED = 'ads.dock_expanded',
  /** The detail panel closed, with the method that closed it and the dwell. */
  ADS_DOCK_COLLAPSED = 'ads.dock_collapsed',

  // Web - Token Count API
  TOKEN_COUNT_REQUEST = 'api.token_count_request',
  TOKEN_COUNT_AUTH_ERROR = 'api.token_count_auth_error',
  TOKEN_COUNT_VALIDATION_ERROR = 'api.token_count_validation_error',
  TOKEN_COUNT_ERROR = 'api.token_count_error',

  // Freebuff - Creator Attribution
  FREEBUFF_REFERRER_ATTRIBUTED = 'freebuff.referrer_attributed',

  // Freebuff - Referral program server lifecycle (emitted from packages/billing
  // via the server logger → Axiom `event` column).
  FREEBUFF_REFERRAL_REDEEMED = 'freebuff.referral.redeemed',
  // A redemption attempt that hit one of the one-shot eligibility guards
  // (signup_too_old, user_banned, referrer_limit_reached, reverse_referral,
  // self_referral). Deliberately EXCLUDES the two repeat-prone errors —
  // invalid_code (cookie intentionally kept for legacy codes) and
  // already_referred (cookie can outlive redemption on the /onboard RSC hop)
  // — which would otherwise re-fire on every <=10-min token mint; those log
  // at debug only. Without this event, a "my friend's invite didn't count"
  // support case is undiagnosable — the guards otherwise return silently.
  FREEBUFF_REFERRAL_REDEEM_FAILED = 'freebuff.referral.redeem_failed',
  // Attribution went through and the referred user redeemed from an IP or
  // browser the REFERRER was recently seen on. Evidence, NOT a verdict: this
  // is also exactly what a genuine in-person referral looks like ("try it,
  // here's my laptop" — a sibling on the family computer shares both). Only
  // suspicious when corroborated by real farm signals (dormant GitHub, burst
  // velocity, no product use); the sweep + scripts do that weighing.
  FREEBUFF_REFERRAL_SOCK_SIGNAL = 'freebuff.referral.sock_signal',
  // Freebuff - Get Started Page (referral onboarding funnel, in order:
  //   viewed → sign_in_clicked → signed_in → eligibility_resolved →
  //   [connect_github_clicked] → install_command_copied | web_clicked).
  // Every event carries a `referrer` prop (the inviter's name) for per-referrer
  // funnel breakdowns.
  FREEBUFF_GET_STARTED_VIEWED = 'freebuff.get_started_viewed',
  FREEBUFF_GET_STARTED_SIGN_IN_CLICKED = 'freebuff.get_started_sign_in_clicked',
  FREEBUFF_GET_STARTED_SIGNED_IN = 'freebuff.get_started_signed_in',
  FREEBUFF_GET_STARTED_ELIGIBILITY_RESOLVED = 'freebuff.get_started_eligibility_resolved',
  FREEBUFF_GET_STARTED_CONNECT_GITHUB_CLICKED = 'freebuff.get_started_connect_github_clicked',
  FREEBUFF_GET_STARTED_INSTALL_COMMAND_COPIED = 'freebuff.get_started_install_command_copied',
  FREEBUFF_GET_STARTED_WEB_CLICKED = 'freebuff.get_started_web_clicked',
  // Deprecated (previous get-started design — no longer fired):
  FREEBUFF_GET_STARTED_HELP_EXPANDED = 'freebuff.get_started_help_expanded',
  FREEBUFF_GET_STARTED_EDITOR_CLICKED = 'freebuff.get_started_editor_clicked',

  // Freebuff - Chat
  // Emitted once per new-thread title generation attempt (server-side). The
  // `outcome` property is one of: generated | empty | unknown_model | error |
  // aborted. Carries `latencyMs`, `model`, and `titleLength` so the failure/
  // fallback rate and added latency are queryable.
  FREEBUFF_CHAT_TITLE_GENERATED = 'freebuff.chat_title_generated',

  // Freebuff - CLI landing page (/cli). Fired when the install command is
  // copied; `location` distinguishes hero vs install section. Lets us measure
  // install intent per campaign (utm_* ride along as super-properties) — the
  // best proxy conversion for CLI traffic, since CLI activation happens in a
  // separate identity space with no key back to the web landing.
  FREEBUFF_CLI_INSTALL_COMMAND_COPIED = 'freebuff.cli_install_command_copied',

  // Freebuff - Enterprise landing page (/enterprise). Fired when the contact
  // form is submitted successfully; carries `companySize` and whether the
  // sender self-identified as an AI lab, so inbound demand can be segmented
  // without reading the emails. The lead itself lands in james@/victor@ inboxes
  // — this event only measures the funnel into them.
  FREEBUFF_ENTERPRISE_CONTACT_SUBMITTED = 'freebuff.enterprise_contact_submitted',

  // Freebuff - Desktop download CTAs (home hero, products row, /desktop).
  // Fired on every click of a download button; `location` distinguishes the
  // CTA, `platform` the build, and `repeat: true` marks a click we swallowed
  // because the same download had just started (the "did that work?" double
  // click) — a direct read on whether the click feedback is landing.
  FREEBUFF_DESKTOP_DOWNLOAD_CLICKED = 'freebuff.desktop_download_clicked',

  // Freebuff Web creation gate: the user's idea was screened as something Web
  // cannot build, and they clicked through to the surface we suggested.
  // `surface` is desktop | cli | unsupported. Pairs with the Convex
  // web_gate_decision row (which carries the same click) — PostHog answers
  // "did the redirect land?" across the funnel, Convex answers "for which
  // ideas?". Both exist because the Convex row cannot see what the user does
  // after leaving /web.
  FREEBUFF_WEB_GATE_REDIRECT_CLICKED = 'freebuff.web_gate_redirect_clicked',

  // Freebuff Web first-session onboarding. The details sequence runs in the
  // chat pane while the first build streams; its answers are composed into the
  // user's SECOND prompt, which is the drop-off metric this exists to move
  // (51% of Web projects never get one). `_STEP` fires per question with
  // whether it was answered or skipped, so the funnel shows which question
  // people bail on. `_FINISHED` carries `answered` (0-4) and `sent`.
  FREEBUFF_WEB_ONBOARDING_STEP = 'freebuff.web_onboarding_step',
  FREEBUFF_WEB_ONBOARDING_FINISHED = 'freebuff.web_onboarding_finished',

  // The workspace spotlight tour that follows the first build. `_STEP` fires
  // per pane shown (preview/database/logs/publish/chat); `_FINISHED` records
  // completed vs skipped and where they stopped.
  FREEBUFF_WEB_TOUR_STEP = 'freebuff.web_tour_step',
  FREEBUFF_WEB_TOUR_FINISHED = 'freebuff.web_tour_finished',

  // The bookmark gate: a blocking card shown once per browser, right after the
  // user's first prompt in a Web or Cloud workspace, asking them to bookmark
  // the page before continuing. `surface` is web | cloud and `variant` is
  // pointer | touch (the two illustrations). `_SHOWN` minus `_CONFIRMED` is the
  // abandon rate — the number to watch, since the card has no other exit and a
  // gap between the two means people are closing the tab instead.
  FREEBUFF_BOOKMARK_GATE_SHOWN = 'freebuff.bookmark_gate_shown',
  FREEBUFF_BOOKMARK_GATE_CONFIRMED = 'freebuff.bookmark_gate_confirmed',

  // Freebuff - Cloud landing page (/cloud). Fired when a logged-out visitor
  // clicks a "Continue with GitHub" / "Connect your repo" CTA; `location`
  // distinguishes hero vs the migration/lovable section vs the final CTA. Best
  // proxy for cloud sign-up intent (utm_* ride along as super-properties).
  FREEBUFF_CLOUD_CONNECT_REPO_CLICKED = 'freebuff.cloud_connect_repo_clicked',
  FREEBUFF_CLOUD_BLANK_PROJECT_CLICKED = 'freebuff.cloud_blank_project_clicked',

  // Freebuff - Home Page
  FREEBUFF_HOME_INSTALL_COMMAND_COPIED = 'freebuff.home_install_command_copied',
  FREEBUFF_HOME_GITHUB_CLICKED = 'freebuff.home_github_clicked',
  FREEBUFF_HOME_INSTALL_GUIDE_EXPANDED = 'freebuff.home_install_guide_expanded',
  FREEBUFF_HOME_FAQ_OPENED = 'freebuff.home_faq_opened',

  // Freebuff - Home savings calculator CTA. Fires alongside
  // FREEBUFF_DESKTOP_DOWNLOAD_CLICKED (location: savings_calculator) but adds
  // what the visitor had configured at the moment they converted: `savings`
  // (the headline number they were looking at), `perSeat`, `seats`, `tools`
  // and `toolCount`. The question it exists to answer is whether a bigger
  // computed number actually converts better — bucket `savings` and compare
  // click-through, which the download event alone cannot show.
  FREEBUFF_HOME_SAVINGS_CTA_CLICKED = 'freebuff.home_savings_cta_clicked',

  // Freebuff - acquisition attribution (UTM / ad-click params captured as
  // super-properties; filter by utm_source, reddit_click_id, is_reddit_traffic)
  FREEBUFF_ATTRIBUTED = 'freebuff.attributed',
  FREEBUFF_AFFILIATE_SIGNUP = 'freebuff.affiliate.signup',
  FREEBUFF_AFFILIATE_ACTIVATION = 'freebuff.affiliate.activation',
  // Freebuff - Reddit ad funnel (filter in PostHog by reddit_click_id / utm_source)
  FREEBUFF_REDDIT_FUNNEL_CLI_INSTALLED = 'freebuff.reddit_funnel.cli_installed',
  FREEBUFF_REDDIT_FUNNEL_LOGIN = 'freebuff.reddit_funnel.login',
  FREEBUFF_REDDIT_FUNNEL_SIGN_UP = 'freebuff.reddit_funnel.sign_up',
  FREEBUFF_REDDIT_FUNNEL_FIRST_PROMPT = 'freebuff.reddit_funnel.first_prompt',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_1D = 'freebuff.reddit_funnel.retention_1d',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_7D = 'freebuff.reddit_funnel.retention_7d',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_24D = 'freebuff.reddit_funnel.retention_24d',
  // Legacy surface-specific names retained for historical dashboards.
  FREEBUFF_REDDIT_FUNNEL_FIRST_PROMPT_CLI = 'freebuff.reddit_funnel.first_prompt_cli',
  FREEBUFF_REDDIT_FUNNEL_FIRST_PROMPT_WEB = 'freebuff.reddit_funnel.first_prompt_web',
  FREEBUFF_REDDIT_FUNNEL_FIRST_PROMPT_CHAT = 'freebuff.reddit_funnel.first_prompt_chat',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_1D_CLI = 'freebuff.reddit_funnel.retention_1d_cli',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_7D_CLI = 'freebuff.reddit_funnel.retention_7d_cli',
  FREEBUFF_REDDIT_FUNNEL_RETENTION_24D_CLI = 'freebuff.reddit_funnel.retention_24d_cli',
  FREEBUFF_REDDIT_FUNNEL_GRAVITY_AD_CLICK = 'freebuff.reddit_funnel.gravity_ad_click',

  // Freebuff web /chat ads experiment (server-rendered Gravity ads vs the
  // existing @gravity-ai/react inline slot; bucketed by user id — see
  // freebuff/web/src/app/chat/_components/ad-experiment.ts). Both events carry
  // `experiment` + `variant` so PostHog can break down exposure and CTR by arm.
  FREEBUFF_CHAT_ADS_EXPERIMENT_EXPOSED = 'freebuff.chat_ads.experiment_exposed',
  FREEBUFF_CHAT_ADS_AD_SHOWN = 'freebuff.chat_ads.ad_shown',

  // Freebuff Desktop (Electron app)
  // Mirrors the CLI's surface events so the desktop shows up in the same DAU /
  // login funnels. `message_sent` (above) is reused with `surface: 'desktop'`;
  // these capture the launch, auth, and per-turn activity unique to the app.
  DESKTOP_APP_LAUNCHED = 'desktop.app_launched',
  // The ATTEMPT, which `desktop.login` (the completion) cannot stand in for. A screen that gets
  // more people to press the button and a screen nobody presses look identical in completions
  // alone if sign-in itself is what breaks — and the first-run screen exists to move exactly this
  // number. `surface` says which control started it, so a change to one of them is separable.
  DESKTOP_LOGIN_STARTED = 'desktop.login_started',
  DESKTOP_LOGIN = 'desktop.login',
  // Every way device-code sign-in can fail on the client. Without it a user who
  // cannot sign in is INVISIBLE: `/api/auth/cli/code` answers 200 on all of
  // them (unreachable host, TLS interception, clock skew, an abandoned code),
  // so the server sees a healthy login it never hears about again.
  DESKTOP_LOGIN_FAILED = 'desktop.login_failed',
  DESKTOP_LOGOUT = 'desktop.logout',
  DESKTOP_THREAD_CREATED = 'desktop.thread_created',
  DESKTOP_THREAD_TITLED = 'desktop.thread_titled',
  DESKTOP_PROJECT_OPENED = 'desktop.project_opened',
  DESKTOP_PROJECT_REMOVED = 'desktop.project_removed',
  DESKTOP_TURN_COMPLETED = 'desktop.turn_completed',
  DESKTOP_FAILED_TURN_RECOVERY = 'desktop.failed_turn_recovery',
  DESKTOP_HARNESS_CHANGED = 'desktop.harness_changed',
  DESKTOP_MODEL_CHANGED = 'desktop.model_changed',
  DESKTOP_SKILL_RUN = 'desktop.skill_run',
  DESKTOP_QUEUE_SEND_NOW = 'desktop.queue_send_now',
  // Feature-adoption catch-all. ONE event for the long tail of desktop
  // features (panels, worktrees, diffs, skills, terminal, preview, …), keyed
  // by a bounded `feature` property from
  // `freebuff-desktop/src/core/features.ts`. A single PostHog insight
  // ("desktop.feature_used, broken down by feature", unique users) answers
  // "what do people actually use?" for the whole app, and adding a feature
  // never means adding an event to this enum or to the sampling lists.
  //
  // Reserved for user-INTENT actions only — never render/effect churn. The
  // first-class desktop.* events above stay separate because they anchor
  // funnels (login, DAU, turns) or reliability alerts.
  DESKTOP_FEATURE_USED = 'desktop.feature_used',
  DESKTOP_AUTORUN_TOGGLED = 'desktop.autorun_toggled',
  DESKTOP_AUTORUN_SCOPE_SET = 'desktop.autorun_scope_set',
  // One-shot per process: which codex CLI the Codex harness resolved (or why
  // none). Answers "is the packaged app finding users' codex?" in the field,
  // where the stdout breadcrumb is unavailable.
  DESKTOP_CODEX_RESOLUTION = 'desktop.codex_resolution',
  // Sponsored ads interspersed into the transcript (server-side ads_* events
  // in web/api/v1/ads capture the fetch/impression/click ledger; these are the
  // desktop-surface funnels). `desktop.inline_ad_pool_reused` was retired
  // along with the head-pool model (ads are now inline parts capped at
  // MAX_MESSAGE_AD_COUNT); historical rows exist but nothing emits it. The
  // CLI's `cli.inline_ad_pool_reused` sibling remains Axiom-only.
  DESKTOP_AD_SHOWN = 'desktop.ad_shown',
  DESKTOP_AD_CLICKED = 'desktop.ad_clicked',
  DESKTOP_INLINE_AD_SLOT_ELIGIBLE = 'desktop.inline_ad_slot_eligible',
  // Shutdown/crash lifecycle of harness CLI children: turns aborted at quit so
  // their CLIs terminate, orphans from a dead orchestrator reaped at launch,
  // and interrupted turns auto-resumed by recovery. Together these answer "how
  // often do users hit the orphaned-CLI zombie?" in the field.
  DESKTOP_SHUTDOWN_TURNS_ABORTED = 'desktop.shutdown_turns_aborted',
  DESKTOP_ORPHANS_REAPED = 'desktop.orphans_reaped',
  DESKTOP_WORKTREES_RECLAIMED = 'desktop.worktrees_reclaimed',
  DESKTOP_TURNS_RESURRECTED = 'desktop.turns_resurrected',
  // Passive stall detector: a turn produced no harness stream activity for the
  // configured window. Telemetry ONLY — the turn is not aborted. Join to
  // desktop.turn_completed to tell a recovered long-silent tool call from a
  // real hang, i.e. whether an *acting* watchdog is worth building.
  DESKTOP_TURN_STALLED = 'desktop.turn_stalled',
  // A turn that went quiet because it is PARKED on a background command, not
  // because anything is wrong. Verified against the real Claude Code CLI: a
  // background Bash wait emits no stream messages whatsoever for its entire
  // duration, so the stall detector cannot tell it apart from a hang by
  // listening. This event is what the detector reports instead, so a long wait
  // is still counted — and stays out of desktop.turn_stalled, which is meant to
  // mean "unexplained silence".
  DESKTOP_TURN_BACKGROUND_WAIT = 'desktop.turn_background_wait',
  // Saturation of the orchestrator's single event loop, one line per minute per
  // running app. That process serves the renderer bundle, every SSE stream, all
  // git work, agent turns, terminals and preview drives, so a stall anywhere
  // reads to the user as the whole app hanging. The same numbers ride on
  // `desktop.turn_completed`, which is what separates "the backend queued my
  // turn" from "my own orchestrator was pinned" — the question the 2026-07
  // "opening a new tab is incredibly slow" report could not be answered from
  // server-side timings alone.
  DESKTOP_EVENT_LOOP_HEALTH = 'desktop.event_loop_health',
  // Background lifecycle outcomes. Counts are bucketed and conflict changes
  // emit only on transitions, so periodic scans do not create cardinality or volume churn.
  DESKTOP_THREADS_AUTO_ARCHIVED = 'desktop.threads_auto_archived',
  DESKTOP_DELIVERY_CONFLICT_CHANGED = 'desktop.delivery_conflict_changed',

  // Common
  FLUSH_FAILED = 'common.flush_failed',
}
