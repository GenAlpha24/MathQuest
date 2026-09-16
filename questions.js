/* =====================================================================
   Math Quest — Question bank
   ---------------------------------------------------------------------
   This file is the "questions database" + the logic that builds them.
   It is intentionally kept SEPARATE from the game engine (index.html):

     - GRADE_TABLE below is the *data*: which extra topics each grade
       practices, how likely each is, and the number ranges to use.
       Tweak this table to change difficulty or add/remove topics.

     - The make*() helpers are the topic *generators*.

     - The engine only calls three things:
         MathQuest.Questions.make(grade, level)  -> question object
         MathQuest.Questions.hint(question)      -> help text (string)
         MathQuest.Questions.videoTopic(question)-> search phrase (string)

   A question object looks like:
     { text, answer, opts:[...], topic?, ...extra fields for hints }

   Grade codes:  -2 Pre-K, -1 TK, 0 Kindergarten, 1..5 Grade 1..5
   ===================================================================== */
(function () {
  "use strict";

  // ---- tiny helpers ----
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // =====================================================================
  //  TOPIC GENERATORS  (each returns a question object)
  // =====================================================================
  const PLACE_NAMES = ["ones", "tens", "hundreds", "thousands", "ten thousands"];

  // Place value: "In 4,382, which digit is in the hundreds place?"
  // digitsCount controls how many digits the number has (2..5).
  function makePlaceValue(digitsCount) {
    const min = Math.pow(10, digitsCount - 1);
    const max = Math.pow(10, digitsCount) - 1;
    const num = rand(min, max);
    const digits = String(num).split("").map(Number); // left..right
    const idx = rand(0, digitsCount - 1);              // 0 => ones place
    const placeName = PLACE_NAMES[idx];
    const answer = digits[digits.length - 1 - idx];    // digit in that place
    const options = new Set([answer]);
    for (const d of digits) { if (options.size < 4) options.add(d); }
    let f = 0;
    while (options.size < 4 && f <= 9) { options.add(f); f++; }
    return {
      text: `In ${num.toLocaleString()}, which digit is in the ${placeName} place?`,
      answer, opts: shuffle([...options]),
      topic: "placeValue", num, place: placeName,
    };
  }

  // Compare two numbers in [min,max] with <, >, or =
  function makeCompare(min, max) {
    const a = rand(min, max);
    const b = Math.random() < 0.15 ? a : rand(min, max);
    const answer = a < b ? "<" : a > b ? ">" : "=";
    return {
      text: `Compare:  ${a.toLocaleString()}  ?  ${b.toLocaleString()}`,
      answer, opts: shuffle(["<", ">", "="]),
      topic: "compare", a, b,
    };
  }

  // Round to the nearest 10/100/1000. `nearestArg` is a single value or an
  // array of choices; `maxNum` caps the number being rounded.
  function makeRounding(nearestArg, maxNum) {
    const nearest = Array.isArray(nearestArg)
      ? nearestArg[rand(0, nearestArg.length - 1)]
      : nearestArg;
    const num = rand(nearest + 1, maxNum);
    const answer = Math.round(num / nearest) * nearest;
    const options = new Set([answer]);
    options.add(Math.floor(num / nearest) * nearest);
    options.add(Math.ceil(num / nearest) * nearest);
    options.add(answer + nearest);
    options.add(answer - nearest);
    const clean = [...options].filter(v => v >= 0 && v !== answer);
    const opts = new Set([answer]);
    for (const v of shuffle(clean)) { if (opts.size < 4) opts.add(v); }
    let f = answer + nearest * 2;
    while (opts.size < 4) { opts.add(f); f += nearest; }
    return {
      text: `Round ${num.toLocaleString()} to the nearest ${nearest.toLocaleString()}.`,
      answer, opts: shuffle([...opts]),
      topic: "rounding", num, nearest,
    };
  }

  // Factors: "Which number is a factor of 24?" (Grade 4-5)
  function makeFactors() {
    // pick a composite number with several factors
    const bases = [12, 16, 18, 20, 24, 28, 30, 36, 40, 48];
    const num = bases[rand(0, bases.length - 1)];
    const factors = [];
    for (let i = 2; i < num; i++) if (num % i === 0) factors.push(i);
    const answer = factors[rand(0, factors.length - 1)];
    // wrong options: numbers that are NOT factors of num
    const opts = new Set([answer]);
    let guard = 0;
    while (opts.size < 4 && guard++ < 100) {
      const w = rand(2, num - 1);
      if (num % w !== 0) opts.add(w);
    }
    return {
      text: `Which of these is a factor of ${num}?`,
      answer, opts: shuffle([...opts]),
      topic: "factors", num,
    };
  }

  // Order of operations: "3 + 4 × 2 = ?" (Grade 4 no parens, Grade 5 parens)
  function makeOrderOfOps(useParens) {
    const a = rand(2, 9), b = rand(2, 9), c = rand(2, 6);
    let text, answer;
    if (useParens && Math.random() < 0.5) {
      answer = (a + b) * c;
      text = `(${a} + ${b}) × ${c} = ?`;
    } else if (Math.random() < 0.5) {
      answer = a + b * c;
      text = `${a} + ${b} × ${c} = ?`;
    } else {
      answer = a * b - c;
      text = `${a} × ${b} − ${c} = ?`;
    }
    const options = new Set([answer]);
    const spread = Math.max(3, Math.round(answer * 0.3));
    let guard = 0;
    while (options.size < 4 && guard++ < 100) {
      const w = answer + rand(-spread, spread);
      if (w >= 0 && w !== answer) options.add(w);
    }
    let f = answer + 1;
    while (options.size < 4) { if (f !== answer && f >= 0) options.add(f); f++; }
    return {
      text, answer, opts: shuffle([...options]),
      topic: "orderOfOps",
    };
  }

  // Telling time: "quarter past 4" -> 4:15 (Grade 2)
  function makeTelling() {
    const hour = rand(1, 12);
    const minutes = [0, 15, 30, 45][rand(0, 3)];
    const mm = String(minutes).padStart(2, "0");
    const answer = `${hour}:${mm}`;
    const words = minutes === 0 ? `${hour} o'clock`
      : minutes === 15 ? `quarter past ${hour}`
      : minutes === 30 ? `half past ${hour}`
      : `quarter to ${hour === 12 ? 1 : hour + 1}`;
    const opts = new Set([answer]);
    let guard = 0;
    while (opts.size < 4 && guard++ < 100) {
      const h2 = rand(1, 12);
      const m2 = [0, 15, 30, 45][rand(0, 3)];
      opts.add(`${h2}:${String(m2).padStart(2, "0")}`);
    }
    return {
      text: `Which clock time is "${words}"?`,
      answer, opts: shuffle([...opts]),
      topic: "time", words,
    };
  }

  // =====================================================================
  //  ARITHMETIC  (the default question type for every grade)
  // =====================================================================

  // Early learners (Pre-K / TK / Kindergarten): tiny numbers, 3 choices.
  function makeEarly(grade) {
    const maxNum = grade === -2 ? 3 : 5; // Pre-K:3, TK/K:5
    const useSub = grade === 0 && Math.random() < 0.4; // K adds subtraction
    let a, b, opSym, answer;
    if (useSub) {
      a = rand(1, maxNum); b = rand(0, a);
      opSym = "−"; answer = a - b;
    } else {
      a = rand(0, maxNum); b = rand(0, Math.max(0, maxNum - a)); // keep sum small
      opSym = "+"; answer = a + b;
    }
    const opt = new Set([answer]);
    let g = 0;
    while (opt.size < 3 && g++ < 50) {
      const w = answer + rand(-2, 2);
      if (w >= 0 && w !== answer) opt.add(w);
    }
    let f = answer + 1;
    while (opt.size < 3) { if (f !== answer && f >= 0) opt.add(f); f++; }
    return {
      text: `${a} ${opSym} ${b} = ?`, answer, opts: shuffle([...opt]),
      a, b, op: opSym === "−" ? "-" : "+",
    };
  }

  // Grades 1-5 arithmetic. Range and allowed operations grow with grade,
  // plus a small bump every couple of levels.
  function makeArithmetic(grade, lv) {
    // +1 difficulty every 2 levels. Grade 3 climbs more gently (every 3).
    const bump = grade === 3
      ? Math.floor((lv - 1) / 3)
      : Math.floor((lv - 1) / 2);

    let allowedOps;
    if (grade <= 2)      allowedOps = ["+", "-"];
    else if (grade === 3) allowedOps = ["+", "-", "*"];
    else                  allowedOps = ["+", "-", "*", "/"];

    const op = allowedOps[Math.floor(Math.random() * allowedOps.length)];

    let range;
    if (grade <= 1)      range = 10;
    else if (grade === 2) range = 20;
    else if (grade === 3) range = 30;
    else if (grade === 4) range = 100;
    else                  range = 200;
    range += bump * 5;

    let a, b, answer;
    if (op === "+") {
      a = rand(1, range); b = rand(1, range);
      answer = a + b;
    } else if (op === "-") {
      a = rand(1, range); b = rand(1, a); // no negative answers
      answer = a - b;
    } else if (op === "*") {
      const maxFactor = (grade === 3 ? 5 : grade === 4 ? 12 : 15) + bump;
      a = rand(2, maxFactor); b = rand(2, maxFactor);
      answer = a * b;
    } else { // division with a whole-number answer
      const maxDivisor = (grade === 4 ? 10 : 12) + bump;
      b = rand(2, maxDivisor);
      answer = rand(2, maxDivisor);
      a = b * answer; // ensures a / b is exact
    }

    const opSymbols = { "+": "+", "-": "−", "*": "×", "/": "÷" };
    const spread = Math.max(5, Math.round(answer * 0.3));
    const options = new Set([answer]);
    let guard = 0;
    while (options.size < 4 && guard++ < 100) {
      const wrong = answer + rand(-spread, spread);
      if (wrong >= 0 && wrong !== answer) options.add(wrong);
    }
    let filler = answer + 1;
    while (options.size < 4) { if (filler !== answer && filler >= 0) options.add(filler); filler++; }

    return {
      text: `${a} ${opSymbols[op]} ${b} = ?`,
      answer, opts: shuffle([...options]), a, b, op,
    };
  }

  // =====================================================================
  //  GRADE TABLE  (the "database")
  //  For each grade, a list of extra topics with a cumulative probability.
  //  make() rolls a number in [0,1): the first topic whose `upTo` exceeds
  //  the roll is used; if none match, we fall back to arithmetic.
  //  Skills are drawn from the Mashup Math grade-level curriculum.
  // =====================================================================
  const GRADE_TABLE = {
    1: [ // place value (tens/ones) + comparing small numbers
      { upTo: 0.18, gen: () => makePlaceValue(2) },
      { upTo: 0.30, gen: () => makeCompare(1, 20) },
    ],
    2: [ // place value (hundreds), rounding to 10, compare, telling time
      { upTo: 0.15, gen: () => makePlaceValue(3) },
      { upTo: 0.27, gen: () => makeRounding(10, 100) },
      { upTo: 0.37, gen: () => makeCompare(10, 200) },
      { upTo: 0.47, gen: () => makeTelling() },
    ],
    3: [ // place value to thousands, compare, round to 10/100
      { upTo: 0.20, gen: () => makePlaceValue(4) },
      { upTo: 0.35, gen: () => makeCompare(100, 9999) },
      { upTo: 0.50, gen: () => makeRounding([10, 100], 1000) },
    ],
    4: [ // bigger place value, rounding, factors, order of operations
      { upTo: 0.15, gen: () => makePlaceValue(5) },
      { upTo: 0.28, gen: () => makeRounding([10, 100, 1000], 10000) },
      { upTo: 0.40, gen: () => makeFactors() },
      { upTo: 0.52, gen: () => makeOrderOfOps(false) },
    ],
    5: [ // order of operations, factors, rounding large numbers
      { upTo: 0.20, gen: () => makeOrderOfOps(true) },
      { upTo: 0.32, gen: () => makeFactors() },
      { upTo: 0.44, gen: () => makeRounding([100, 1000], 100000) },
    ],
  };

  // Pick a topic question from the table for this grade, or null.
  function maybeTopicQuestion(grade) {
    const table = GRADE_TABLE[grade];
    if (!table) return null;
    const r = Math.random();
    for (const entry of table) {
      if (r < entry.upTo) return entry.gen();
    }
    return null;
  }

  // =====================================================================
  //  PUBLIC API
  // =====================================================================

  // Build a question for the given grade and current game level.
  function make(grade, level) {
    if (grade <= 0) return makeEarly(grade);          // Pre-K / TK / K
    const topic = maybeTopicQuestion(grade);          // grade-specific skills
    if (topic) return topic;
    return makeArithmetic(grade, level);              // default arithmetic
  }

  // Build a friendly, step-by-step explanation for a question object.
  function hint(q) {
    const { a, b, op, answer } = q;

    // Grade-level topic questions have their own explanations.
    if (q.topic === "placeValue") {
      return `Place value tells you what each digit is worth.\n` +
             `Reading ${q.num.toLocaleString()} from the right: ones, tens, hundreds, thousands.\n` +
             `The digit in the ${q.place} place is ${answer}.`;
    }
    if (q.topic === "compare") {
      const word = answer === "<" ? "less than" : answer === ">" ? "greater than" : "equal to";
      return `Compare the numbers place by place, starting from the left.\n` +
             `${q.a.toLocaleString()} is ${word} ${q.b.toLocaleString()}.\n` +
             `The open side of < or > always points to the bigger number.`;
    }
    if (q.topic === "rounding") {
      return `To round ${q.num.toLocaleString()} to the nearest ${q.nearest.toLocaleString()}:\n` +
             `look at the digit just to the right of that place.\n` +
             `5 or more rounds up, 4 or less rounds down → ${answer.toLocaleString()}.`;
    }
    if (q.topic === "factors") {
      return `A factor divides a number evenly, with nothing left over.\n` +
             `Check: does ${q.num} ÷ (the choice) give a whole number?\n` +
             `${q.num} ÷ ${answer} = ${q.num / answer}, so ${answer} is a factor.`;
    }
    if (q.topic === "orderOfOps") {
      return `Follow the order of operations (PEMDAS):\n` +
             `do anything in parentheses first, then × and ÷, then + and −.\n` +
             `Working left to right within each step gives ${answer}.`;
    }
    if (q.topic === "time") {
      return `Read the hour first, then the minutes.\n` +
             `"${q.words}" matches ${answer}.\n` +
             `Quarter past = :15, half past = :30, quarter to = :45.`;
    }

    // Arithmetic explanations.
    if (op === "+") {
      return `Addition means putting groups together.\n` +
             `Start at ${a}, then count up ${b} more.\n` +
             `${a} + ${b} = ${answer}.`;
    }
    if (op === "-") {
      return `Subtraction means taking away.\n` +
             `Start at ${a}, then count back ${b}.\n` +
             `${a} − ${b} = ${answer}.`;
    }
    if (op === "*") {
      return `Multiplication is repeated addition.\n` +
             `${a} × ${b} means adding ${a} together ${b} times:\n` +
             `${Array(Math.min(b, 6)).fill(a).join(" + ")}${b > 6 ? " + …" : ""} = ${answer}.`;
    }
    // division
    return `Division means sharing into equal groups.\n` +
           `${a} ÷ ${b} asks: how many groups of ${b} fit in ${a}?\n` +
           `Because ${b} × ${answer} = ${a}, the answer is ${answer}.`;
  }

  // A kid-friendly search phrase used by the "Watch Video" button.
  const OP_WORD = { "+": "addition", "-": "subtraction", "*": "multiplication", "/": "division" };
  const TOPIC_WORD = {
    placeValue: "place value",
    compare: "comparing numbers greater than less than",
    rounding: "rounding numbers",
    factors: "factors of a number",
    orderOfOps: "order of operations PEMDAS",
    time: "telling time on a clock",
  };
  function videoTopic(q) {
    return TOPIC_WORD[q.topic] || OP_WORD[q.op] || "math";
  }

  // Expose the API on a global namespace (no build step / modules needed).
  window.MathQuest = window.MathQuest || {};
  window.MathQuest.Questions = { make, hint, videoTopic };
})();
