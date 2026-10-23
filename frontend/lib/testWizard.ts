/**
 * Rule-based decision tree for choosing a statistical test.
 * Pure data, no React. `test` values are backend template names (app/services/r_templates.py).
 */

export interface WizardOption {
  label: string
  hint?: string
  next: string
}

export interface WizardQuestion {
  kind: 'question'
  text: string
  help?: string
  options: WizardOption[]
}

export interface WizardAlternative {
  test: string
  label: string
  /** when the user should consider switching, written in terms of lines shown in the results */
  when: string
}

export interface WizardResult {
  kind: 'result'
  /** backend template name, or null when no template exists yet */
  test: string | null
  title: string
  reason: string
  note?: string
  alternative?: WizardAlternative
}

export type WizardNode = WizardQuestion | WizardResult

export const START = 'goal'

const normalityOptions = (yes: string, no: string, unsure: string): WizardOption[] => [
  { label: 'Yes, roughly normal', hint: 'bell-shaped, no strong skew or outliers', next: yes },
  { label: 'No: skewed, ordinal, or a small sample with outliers', next: no },
  { label: "I'm not sure", hint: 'we pick the standard test and show how to check it', next: unsure },
]

export const WIZARD: Record<string, WizardNode> = {
  goal: {
    kind: 'question',
    text: 'What do you want to do?',
    options: [
      { label: 'Compare a numeric outcome between groups', hint: 'e.g. blood pressure in treatment vs control', next: 'groups_n' },
      { label: 'Compare two measurements on the same subjects', hint: 'e.g. before and after treatment', next: 'paired_n' },
      { label: 'See whether two numeric variables are related', hint: 'e.g. age and cholesterol', next: 'r_correlation' },
      { label: 'See whether two categories are associated', hint: 'e.g. treatment group and recovered (yes/no)', next: 'r_chi_square' },
      { label: 'Check whether a variable is normally distributed', next: 'r_shapiro' },
      { label: 'Fit a curve', hint: 'dose-response or enzyme kinetics', next: 'curve_kind' },
    ],
  },

  // ----- independent groups -----
  groups_n: {
    kind: 'question',
    text: 'How many groups are you comparing?',
    help: 'Groups are different subjects (independent), for example treatment A vs B vs C.',
    options: [
      { label: '2 groups', next: 'normal_two' },
      { label: '3 or more groups', next: 'normal_multi' },
    ],
  },
  normal_two: {
    kind: 'question',
    text: 'Is the outcome roughly normally distributed within each group?',
    help: 'With about 30 or more subjects per group, the t-test is usually fine even if the data are not perfectly normal.',
    options: normalityOptions('r_welch', 'r_mwu', 'r_welch_unsure'),
  },
  normal_multi: {
    kind: 'question',
    text: 'Is the outcome roughly normally distributed within each group?',
    help: 'With about 30 or more subjects per group, ANOVA is usually fine even if the data are not perfectly normal.',
    options: normalityOptions('r_anova', 'r_kw', 'r_anova_unsure'),
  },
  r_welch: {
    kind: 'result',
    test: 'independent_t_test',
    title: 'Welch two-sample t-test',
    reason: 'Compares the means of two independent groups without assuming equal variances.',
  },
  r_welch_unsure: {
    kind: 'result',
    test: 'independent_t_test',
    title: 'Welch two-sample t-test',
    reason: 'The standard choice for two independent groups. It compares means without assuming equal variances.',
    note: 'After running it, look at "Normality check by group (Shapiro p)" in the results.',
    alternative: {
      test: 'mann_whitney_u',
      label: 'Switch to Mann-Whitney U',
      when: 'Switch if that normality check shows p < 0.05 and your groups are small (under about 30 each).',
    },
  },
  r_mwu: {
    kind: 'result',
    test: 'mann_whitney_u',
    title: 'Mann-Whitney U test',
    reason: 'Rank-based comparison of two independent groups. It does not assume normality.',
  },
  r_anova: {
    kind: 'result',
    test: 'one_way_anova',
    title: 'One-way ANOVA with Tukey post-hoc',
    reason: 'Compares the means of 3 or more independent groups, then shows which pairs differ.',
  },
  r_anova_unsure: {
    kind: 'result',
    test: 'one_way_anova',
    title: 'One-way ANOVA with Tukey post-hoc',
    reason: 'The standard choice for 3 or more independent groups. It also shows which pairs differ.',
    note: 'After running it, look at "Normality of residuals (Shapiro p)" and "Equal variances (Fligner p)" in the results.',
    alternative: {
      test: 'kruskal_wallis',
      label: 'Switch to Kruskal-Wallis',
      when: 'Switch if either check shows p < 0.05 and your groups are small (under about 30 each).',
    },
  },
  r_kw: {
    kind: 'result',
    test: 'kruskal_wallis',
    title: 'Kruskal-Wallis test',
    reason: 'Rank-based comparison of 3 or more independent groups, followed by Holm-adjusted pairwise comparisons.',
  },

  // ----- paired measurements -----
  paired_n: {
    kind: 'question',
    text: 'How many measurements per subject?',
    help: 'Two means before and after. Three or more means the same subjects measured repeatedly.',
    options: [
      { label: '2 measurements', next: 'normal_paired' },
      { label: '3 or more measurements', next: 'r_repeated' },
    ],
  },
  normal_paired: {
    kind: 'question',
    text: 'Are the differences (first minus second) roughly normally distributed?',
    help: 'With about 30 or more pairs, the paired t-test is usually fine. Prefer Wilcoxon for small samples with skew or outliers.',
    options: normalityOptions('r_paired_t', 'r_wilcoxon', 'r_paired_t_unsure'),
  },
  r_paired_t: {
    kind: 'result',
    test: 'paired_t_test',
    title: 'Paired t-test',
    reason: 'Tests whether the average within-subject difference is zero.',
  },
  r_paired_t_unsure: {
    kind: 'result',
    test: 'paired_t_test',
    title: 'Paired t-test',
    reason: 'The standard choice for two measurements on the same subjects.',
    note: 'After running it, look at "Normality of differences (Shapiro p)" in the results.',
    alternative: {
      test: 'wilcoxon_signed_rank',
      label: 'Switch to Wilcoxon signed-rank',
      when: 'Switch if that check shows p < 0.05 and you have fewer than about 30 pairs.',
    },
  },
  r_wilcoxon: {
    kind: 'result',
    test: 'wilcoxon_signed_rank',
    title: 'Wilcoxon signed-rank test',
    reason: 'Rank-based paired comparison. It does not assume the differences are normal.',
  },
  r_repeated: {
    kind: 'result',
    test: null,
    title: 'Repeated measures (3 or more)',
    reason: 'The Friedman test and repeated-measures ANOVA are not available yet.',
    note: 'In the meantime you can compare two time points at a time with the paired tests, but remember that many comparisons raise the chance of false positives.',
  },

  // ----- relationships and other single-test goals -----
  r_correlation: {
    kind: 'result',
    test: 'pearson_correlation',
    title: 'Pearson and Spearman correlation',
    reason: 'Pearson measures straight-line association. Spearman, reported alongside it, is rank-based and safer with skewed data or outliers.',
  },
  r_chi_square: {
    kind: 'result',
    test: 'chi_square',
    title: 'Chi-square test of independence',
    reason: 'Tests whether two categorical variables are associated. For 2x2 tables the Fisher exact p-value is reported too.',
    note: 'If more than about 20% of expected counts are below 5, trust the Fisher exact result for 2x2 tables.',
  },
  r_shapiro: {
    kind: 'result',
    test: 'shapiro_wilk',
    title: 'Shapiro-Wilk normality test',
    reason: 'Tests whether a numeric variable looks normally distributed, and draws a Q-Q plot.',
    note: 'With large samples it flags tiny, harmless deviations, so look at the Q-Q plot as well.',
  },

  // ----- curve fitting -----
  curve_kind: {
    kind: 'question',
    text: 'What kind of curve?',
    options: [
      { label: 'Dose-response (EC50 / IC50)', hint: 'a sigmoidal curve against concentration', next: 'r_4pl' },
      { label: 'Enzyme kinetics or binding (Vmax/Km, Bmax/Kd)', hint: 'a curve that rises towards a plateau', next: 'r_mm' },
    ],
  },
  r_4pl: {
    kind: 'result',
    test: 'dose_response_4pl',
    title: 'Dose-response: 4-parameter logistic',
    reason: 'Fits a sigmoidal curve on a log10 concentration scale and reports EC50 and Hill slope with 95% confidence intervals.',
  },
  r_mm: {
    kind: 'result',
    test: 'michaelis_menten',
    title: 'Michaelis-Menten / one-site binding',
    reason: 'Fits a hyperbola and reports Vmax and Km (Bmax and Kd for binding data) with 95% confidence intervals.',
  },
}