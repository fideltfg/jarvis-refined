export function fileStem(cue: string): string {
  return cue.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

export function chooseVariant(count: number, last: number, random = Math.random): number {
  const choice = Math.floor(random() * (count - (last >= 0 && count > 1 ? 1 : 0)))
  return last >= 0 && count > 1 && choice >= last ? choice + 1 : choice
}