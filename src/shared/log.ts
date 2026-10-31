/** Line log captured for the demo proof and echoed to stdout. */
export class Logger {
  readonly lines: string[] = []

  info(line: string): void {
    this.lines.push(line)
    console.log(line)
  }

  text(): string {
    return this.lines.join('\n')
  }
}
