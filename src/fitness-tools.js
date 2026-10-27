// Private server-side Supabase read adapter. No dependency required.
// Never expose SUPABASE_SECRET_KEY to the browser, Alice payloads, or GitHub.
function credentials() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error('Supabase is not configured');
  return {base, key};
}
async function select(schema, table, params = {}) {
  const {base, key} = credentials();
  const url = new URL('/rest/v1/' + table, base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const res = await fetch(url, {
    headers: {apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': schema, Accept: 'application/json'},
    signal: AbortSignal.timeout(3500)
  });
  if (!res.ok) throw new Error('Supabase ' + schema + '.' + table + ' HTTP ' + res.status);
  return res.json();
}
export const fitnessTools = Object.freeze({
  async getTodayNutrition(day) {
    const rows = await select('fitness', 'daily_summaries', {day: 'eq.' + day, select: 'day,kcal,protein_g,fat_g,carbs_g', limit: '2'});
    if (!rows.length) return {status: 'missing_day', date: day};
    if (rows.length > 1) return {status: 'duplicate_day', date: day};
    const row = rows[0];
    const consumed = {kcal: row.kcal, protein: row.protein_g, fat: row.fat_g, carbs: row.carbs_g};
    if (Object.values(consumed).some(v => v === null || v === undefined)) return {status: 'incomplete_day', date: day};
    return {status: 'ok', date: day, consumed: Object.fromEntries(Object.entries(consumed).map(([k,v])=>[k, Number(v)]))};
  },
  getNutritionByDate(day) { return this.getTodayNutrition(day); },
  getRecentWorkouts(limit = 30) {
    return select('fitness', 'workout_sets', {select: 'day,exercise,weight_kg,reps,rir,workout_group,set_number', order: 'day.desc,source_row.desc', limit: Math.min(Math.max(1, limit), 100)});
  },
  getExerciseHistory(exercise, limit = 30) {
    if (typeof exercise !== 'string' || !exercise.trim()) throw new Error('Exercise name required');
    // Filter is passed as a URL query value, never interpolated into SQL.
    return select('fitness', 'workout_sets', {select: 'day,exercise,weight_kg,reps,rir,workout_group,set_number', exercise: 'ilike.*' + exercise.replace(/[*,()]/g, '') + '*', order: 'day.desc,source_row.desc', limit: Math.min(Math.max(1, limit), 100)});
  }
});
