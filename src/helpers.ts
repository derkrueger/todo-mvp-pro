export type Priority = 'low' | 'med' | 'high'

export function parseTaskLine(input: string): { title: string, tags: string[], priority: Priority } {
  let title = input
  const tags: string[] = []
  let priority: Priority = 'med'

  // tags: #word
  const tagMatches = [...input.matchAll(/#([\p{L}0-9_-]+)/gu)]
  for (const m of tagMatches) tags.push(m[1].toLowerCase())
  title = title.replace(/#[\p{L}0-9_-]+/gu, '').trim()

  // priority: !low|!med|!high or !l !m !h
  const pr = input.match(/!(low|med|high|l|m|h)/i)
  if (pr) {
    const p = pr[1].toLowerCase()
    priority = p === 'l' ? 'low' : p === 'm' ? 'med' : p === 'h' ? 'high' : (p as Priority)
    title = title.replace(/!(low|med|high|l|m|h)/i, '').trim()
  }

  return { title, tags, priority }
}
