/** Focused trace of a single level, for diagnosing a specific mechanic. */
import { GemKind } from '../engine/types.js';
import { Rng } from '../engine/rng.js';
import { getLevel } from '../game/levels.js';
import { LevelSession } from '../game/session.js';

const id = Number(process.env.LEVEL ?? 149);
const def = getLevel(id);
const session = new LevelSession(def, { seedOffset: 0 });
const rng = new Rng(7);

console.log(
  `level ${id}: ${def.width}x${def.height} shape=${def.shape} colors=${def.colorCount} moves=${def.moves}`,
);
console.log('objectives:', JSON.stringify(def.objectives));
console.log('queue:', session.board.ingredientQueue, 'exits:', JSON.stringify(session.board.exits));
console.log('crates:', def.crates, 'stones:', def.stones, 'locks:', def.locks);

function render(): string {
  const lines: string[] = [];
  for (let r = 0; r < session.board.height; r++) {
    let line = '';
    for (let c = 0; c < session.board.width; c++) {
      const cell = session.board.at(r, c)!;
      if (cell.hole) line += ' .';
      else if (cell.blocker) line += cell.blocker.kind === 'crate' ? ' #' : ' X';
      else if (!cell.gem) line += ' _';
      else if (cell.gem.kind === GemKind.Ingredient) line += ' I';
      else line += ' ' + String(cell.gem.color);
    }
    lines.push(`${String(r).padStart(2)}|${line}`);
  }
  return lines.join('\n');
}

let move = 0;
while (session.state === 'playing' && move < 200) {
  const moves = session.board.findMoves();
  if (!moves.length) {
    session.usePowerup('shuffle');
    continue;
  }
  const pick = moves[rng.int(moves.length)];
  session.swap(pick.a, pick.b);
  move++;

  const rows: string[] = [];
  for (let r = 0; r < session.board.height; r++) {
    for (let c = 0; c < session.board.width; c++) {
      const gem = session.board.gemAt(r, c);
      if (gem && gem.kind === GemKind.Ingredient) rows.push(`r${r}c${c}`);
    }
  }
  if (move <= 8 || move % 10 === 0) {
    console.log(
      `\nmove ${String(move).padStart(3)} left=${session.movesLeft} collected=${session.board.ingredientsCollected} queue=${session.board.ingredientQueue} onboard=[${rows.join(' ')}]`,
    );
    console.log(render());
  }
}
console.log('result:', session.state, 'collected', session.board.ingredientsCollected);
