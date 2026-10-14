"""Symbolic maths for the Equations screen: simplify, expand, factor, differentiate,
integrate, solve, limits and numeric evaluation, using SymPy.

SECURITY. SymPy's parse_expr() runs Python's eval(), so typed text is never handed
to it directly. Every request first passes `check_text`, which allows only a small
set of characters (no quotes, brackets, underscores or attribute dots) and only
known names, then is parsed with an empty `__builtins__` and a fixed namespace.
This is defence in depth, not a sandbox: the HTTP layer (math_runner.py) also runs
this module in a separate process with CPU / memory limits and a wall-clock timeout,
because a harmless-looking input such as 9**9**9**9 can still run forever.

Run as a script (`python -m app.services.math_engine`) it reads one JSON request on
stdin and writes one JSON reply on stdout. Bad input comes back as {"error": "..."}.
"""
from __future__ import annotations

import json
import re
import sys
from tokenize import TokenError
from typing import Any

import sympy as sp
from sympy.parsing.sympy_parser import (
    convert_xor,
    function_exponentiation,
    implicit_multiplication,
    parse_expr,
    standard_transformations,
)

MAX_TEXT = 300
MAX_RESULT_CHARS = 20_000
OPERATIONS = ("simplify", "expand", "factor", "derivative", "integral", "solve", "limit", "numeric")


class MathInputError(Exception):
    """Something the user typed is wrong. The message is shown to them as written."""


# ---------- Names we accept ----------

def _log(*args):
    if len(args) == 1:
        raise MathInputError(
            'Write ln(x) for the natural logarithm, log10(x) for base 10, or log(x, b) for any base. '
            'A bare log(x) is not used because calculators and textbooks disagree on its base.'
        )
    if len(args) == 2:
        return sp.log(args[0], args[1])
    raise MathInputError("log needs a value and a base, for example log(8, 2).")


FUNCTIONS: dict[str, Any] = {
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "cot": sp.cot, "sec": sp.sec, "csc": sp.csc,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
    "asinh": sp.asinh, "acosh": sp.acosh, "atanh": sp.atanh,
    "exp": sp.exp, "ln": sp.log, "log": _log,
    "log10": lambda a: sp.log(a, 10), "log2": lambda a: sp.log(a, 2),
    "sqrt": sp.sqrt, "cbrt": sp.cbrt, "abs": sp.Abs, "sign": sp.sign,
    "floor": sp.floor, "ceil": sp.ceiling, "factorial": sp.factorial,
    "min": sp.Min, "max": sp.Max,
}
CONSTANTS: dict[str, Any] = {"pi": sp.pi, "e": sp.E, "oo": sp.oo}
GREEK = (
    "alpha beta gamma delta epsilon zeta eta theta kappa mu nu xi rho sigma tau phi chi psi omega".split()
)

# What the parser needs to rebuild numbers and names; nothing else is reachable.
_PLUMBING = {"Symbol": sp.Symbol, "Integer": sp.Integer, "Float": sp.Float, "Rational": sp.Rational}

_TRANSFORMATIONS = standard_transformations + (convert_xor, implicit_multiplication, function_exponentiation)

_ALLOWED_CHARS = re.compile(r"^[A-Za-z0-9+\-*/^().,= ]+$")
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9]*")
_SYMBOL = re.compile(r"^[A-Za-z][0-9]*$")  # x, y, t, x1, a2 ...


def _namespace() -> tuple[dict, dict]:
    glob: dict[str, Any] = {"__builtins__": {}}
    glob.update(_PLUMBING)
    glob.update(FUNCTIONS)
    glob.update(CONSTANTS)
    local: dict[str, Any] = {g: sp.Symbol(g) for g in GREEK}
    return glob, local


def check_text(text: str, what: str = "This") -> str:
    """Validate typed maths and return it tidied. Raises MathInputError in plain words."""
    if not isinstance(text, str):
        raise MathInputError(f"{what} must be text.")
    t = text.strip().replace("²", "^2").replace("³", "^3").replace("×", "*").replace("·", "*").replace("−", "-")
    t = t.replace("π", "pi").replace("÷", "/").replace("√", "sqrt")
    if t == "":
        raise MathInputError(f"{what} is empty. Type an expression such as x^2 + 3x.")
    if len(t) > MAX_TEXT:
        raise MathInputError(f"{what} is too long (more than {MAX_TEXT} characters).")
    bad = next((c for c in t if not _ALLOWED_CHARS.match(c)), None)
    if bad is not None:
        raise MathInputError(
            f'{what} contains "{bad}", which is not allowed. Use letters, numbers, + - * / ^ ( ) , = and a decimal point.'
        )
    if re.search(r"\.(?!\d)|(?<!\d)\.", t):
        raise MathInputError(f'{what} has a "." that is not part of a number such as 2.5.')
    if t.count("=") > 1:
        raise MathInputError(f'{what} has more than one "=" sign. An equation has exactly one, for example x^2 = 4.')
    if "==" in t:
        raise MathInputError('Use a single "=" for an equation.')
    depth = 0
    for c in t:
        depth += (c == "(") - (c == ")")
        if depth < 0:
            raise MathInputError(f'{what} has a ")" with no matching "(".')
    if depth:
        raise MathInputError(f'{what} has a "(" that is never closed. Add the matching ")".')
    if re.search(r"\d[eE][\d+-]", t):
        raise MathInputError('Scientific notation such as 2e3 is not used. Write 2*10^3, or 2*e^3 for e cubed.')
    for m in _NAME.finditer(t):
        name = m.group(0)
        after = t[m.end():].lstrip()[:1]
        if name in FUNCTIONS:
            if after not in ("(", "^"):
                raise MathInputError(f"Write {name} with brackets, for example {name}(x).")
        elif name in CONSTANTS or name in GREEK or _SYMBOL.match(name):
            pass
        else:
            raise MathInputError(
                f'Unknown name "{name}". Variables are single letters such as x, y or t. '
                "To multiply letters write x*y, not xy."
            )

    # a(b + c) with a variable in front is multiplication, not a call to a function called a
    def _mul(m: re.Match) -> str:
        name = m.group(0)
        known_fn = name in FUNCTIONS
        after = t[m.end():].lstrip()[:1]
        return name if known_fn or after != "(" else name + "*"

    return _NAME.sub(_mul, t)


def _parse(text: str, *, evaluate: bool = True) -> sp.Basic:
    glob, local = _namespace()
    try:
        return parse_expr(text, global_dict=glob, local_dict=local, transformations=_TRANSFORMATIONS, evaluate=evaluate)
    except MathInputError:
        raise
    except (SyntaxError, TokenError, IndentationError) as e:
        raise MathInputError("This could not be read as maths. Check the brackets and operators.") from e
    except RecursionError:
        raise
    except Exception as e:  # anything else the parser can raise on odd input
        raise MathInputError(f"This could not be read as maths ({_short(e)}).") from e


def _short(e: Exception) -> str:
    s = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
    return s[:120]


def read(text: str, what: str = "This") -> tuple[sp.Basic | sp.Eq, sp.Basic | sp.Eq, str]:
    """Parse typed text. Returns (value to compute with, value to display, tidied text).
    `a = b` becomes Eq(a, b)."""
    t = check_text(text, what)
    if "=" in t:
        left, right = t.split("=", 1)
        if left.strip() == "" or right.strip() == "":
            raise MathInputError(f'{what} needs something on both sides of the "=" sign.')
        eq = sp.Eq(_parse(left), _parse(right), evaluate=False)
        try:
            shown = sp.Eq(_parse(left, evaluate=False), _parse(right, evaluate=False), evaluate=False)
        except Exception:
            shown = eq
        return eq, shown, t
    value = _parse(t)
    try:
        shown = _parse(t, evaluate=False)
    except Exception:
        shown = value
    if not isinstance(value, sp.Expr):
        raise MathInputError(f"{what} did not give a single expression.")
    return value, shown, t


def _symbols(obj: sp.Basic) -> list[sp.Symbol]:
    return sorted(obj.free_symbols, key=lambda s: s.name)


def _pick_variable(names: list[str], wanted: str | None, what: str) -> sp.Symbol:
    if wanted:
        w = check_text(wanted, "The variable")
        if not (_SYMBOL.match(w) or w in GREEK):
            raise MathInputError(f'"{wanted}" is not a variable name. Use a single letter such as x.')
        return sp.Symbol(w)
    if "x" in names:
        return sp.Symbol("x")
    if len(names) == 1:
        return sp.Symbol(names[0])
    if not names:
        return sp.Symbol("x")
    raise MathInputError(f"Choose which variable to {what}: this has {', '.join(names)}.")


# ---------- Output ----------

def _latex(obj: Any) -> str:
    return sp.latex(obj, inv_trig_style="power", ln_notation=True, mul_symbol=None)


def _text(obj: Any) -> str:
    return sp.sstr(obj).replace("**", "^")


# Names the function plotter understands, so a result can be sent straight to it.
_PLOTTER_FUNCS = {
    "sin", "cos", "tan", "sec", "csc", "cot", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp",
    "ln", "sqrt", "cbrt", "abs", "sign", "floor", "ceil", "min", "max",
}
_TO_PLOTTER = {"log": "ln", "Abs": "abs", "ceiling": "ceil", "Max": "max", "Min": "min", "E": "e"}


def plot_text(expr: sp.Basic) -> str | None:
    """The expression in the plotter's own syntax, or None if the plotter could not draw it."""
    if not isinstance(expr, sp.Expr):
        return None
    names = {s.name for s in expr.free_symbols}
    if not names or names - {"x", "y"}:  # a constant would plot as a flat line: not useful
        return None
    if expr.has(sp.I, sp.zoo, sp.nan, sp.oo, -sp.oo, sp.Integral, sp.Sum, sp.Limit, sp.Derivative):
        return None
    s = sp.sstr(expr).replace("**", "^")
    for name in set(_NAME.findall(s)):
        mapped = _TO_PLOTTER.get(name, name)
        if mapped in ("x", "y", "pi", "e") or mapped in _PLOTTER_FUNCS:
            continue
        return None
    s = re.sub(r"\b(" + "|".join(map(re.escape, _TO_PLOTTER)) + r")\b", lambda m: _TO_PLOTTER[m.group(1)], s)
    return s if len(s) <= MAX_TEXT else None


def _numeric(value: sp.Basic, digits: int = 10) -> str | None:
    try:
        if value.free_symbols:
            return None
        n = sp.N(value, digits)
        if n.has(sp.I) and abs(sp.im(n)) < sp.Float(10) ** (-digits):
            n = sp.re(n)
        s = str(n)
        return s if len(s) < 60 else None
    except Exception:
        return None


def _reply(operation: str, *, statement: sp.Basic | None, shown_input: sp.Basic, result: sp.Basic,
           notes: list[str], variables: list[str], extra: dict | None = None, input_plot: sp.Basic | None = None,
           suffix: str = "") -> dict:
    out = {
        "operation": operation,
        "input_latex": _latex(shown_input),
        "statement_latex": _latex(statement) if statement is not None else None,
        "result_latex": _latex(result) + suffix,
        "result_text": _text(result) + (" + C" if suffix else ""),
        "numeric": _numeric(result),
        "plot_text": plot_text(result),
        "input_plot_text": plot_text(input_plot) if input_plot is not None else None,
        "variables": variables,
        "notes": notes,
    }
    if extra:
        out.update(extra)
    for k in ("input_latex", "statement_latex", "result_latex", "result_text"):
        if out[k] and len(out[k]) > MAX_RESULT_CHARS:
            raise MathInputError("The answer is too long to show. Try a simpler expression.")
    return out


# ---------- Operations ----------

def _need_expr(value, what: str):
    if isinstance(value, sp.Equality):
        raise MathInputError(f"This has an \"=\" sign, so {what} does not apply. Use Solve, or remove the \"=\".")
    return value


def run(req: dict) -> dict:
    op = req.get("operation")
    if op not in OPERATIONS:
        raise MathInputError(f"Unknown operation. Choose one of: {', '.join(OPERATIONS)}.")
    value, shown, _ = read(req.get("expression", ""), "The expression")
    names = [s.name for s in _symbols(value)]
    notes: list[str] = []
    wanted = req.get("variable") or None
    input_plot = value if isinstance(value, sp.Expr) else None

    if op in ("simplify", "expand", "factor"):
        _need_expr(value, op)
        fn = {"simplify": sp.simplify, "expand": sp.expand, "factor": sp.factor}[op]
        result = fn(value)
        if result == value:
            notes.append("It is already in this form.")
        return _reply(op, statement=None, shown_input=shown, result=result, notes=notes, variables=names, input_plot=input_plot)

    if op == "numeric":
        _need_expr(value, "a numeric value")
        if names:
            raise MathInputError(f"This still has {', '.join(names)} in it, so it has no single value. Differentiate or solve it instead.")
        result = sp.simplify(value)
        return _reply(op, statement=None, shown_input=shown, result=result, notes=notes, variables=names)

    if op == "derivative":
        _need_expr(value, "differentiating")
        var = _pick_variable(names, wanted, "differentiate with respect to")
        try:
            order = int(req.get("order") or 1)
        except (TypeError, ValueError):
            raise MathInputError("The order of the derivative must be a whole number from 1 to 5.")
        if not 1 <= order <= 5:
            raise MathInputError("The order of the derivative must be a whole number from 1 to 5.")
        statement = sp.Derivative(shown, (var, order))
        result = sp.diff(value, var, order)
        if var.name not in names:
            notes.append(f"This does not contain {var.name}, so its derivative is 0.")
        return _reply(op, statement=statement, shown_input=shown, result=result, notes=notes,
                      variables=names, input_plot=input_plot)

    if op == "integral":
        _need_expr(value, "integrating")
        var = _pick_variable(names, wanted, "integrate with respect to")
        lo_t, hi_t = (req.get("lower") or "").strip(), (req.get("upper") or "").strip()
        if bool(lo_t) != bool(hi_t):
            raise MathInputError("For a definite integral give both limits; for an indefinite one leave both empty.")
        if lo_t:
            lo, _, _ = read(lo_t, "The lower limit")
            hi, _, _ = read(hi_t, "The upper limit")
            for b in (lo, hi):
                if isinstance(b, sp.Equality):
                    raise MathInputError("A limit of integration cannot contain an \"=\" sign.")
            statement = sp.Integral(shown, (var, lo, hi))
            result = sp.integrate(value, (var, lo, hi))
            suffix = ""
        else:
            statement = sp.Integral(shown, var)
            result = sp.integrate(value, var)
            suffix = " + C"
        if result.has(sp.Integral):
            raise MathInputError("SymPy could not find a closed-form answer for this integral.")
        if lo_t and result.has(sp.nan, sp.zoo):
            raise MathInputError("This integral does not exist between those limits (the function blows up inside them).")
        if suffix:
            notes.append("C is the constant of integration.")
        return _reply(op, statement=statement, shown_input=shown, result=result, notes=notes,
                      variables=names, input_plot=input_plot, suffix=suffix)

    if op == "limit":
        _need_expr(value, "a limit")
        var = _pick_variable(names, wanted, "take the limit of")
        point_t = (req.get("point") or "").strip()
        if not point_t:
            raise MathInputError("Say where the limit is taken, for example 0 or oo (infinity).")
        point, _, _ = read(point_t, "The limit point")
        if isinstance(point, sp.Equality):
            raise MathInputError("The limit point cannot contain an \"=\" sign.")
        direction = req.get("direction") or "both"
        if direction not in ("both", "+", "-"):
            raise MathInputError('The direction must be "both", "+" (from the right) or "-" (from the left).')
        sym_dir = {"both": "+-", "+": "+", "-": "-"}[direction]
        statement = sp.Limit(shown, var, point, dir=sym_dir)
        result = sp.limit(value, var, point, dir=sym_dir)
        if result.has(sp.Limit):
            raise MathInputError("SymPy could not work out this limit.")
        return _reply(op, statement=statement, shown_input=shown, result=result, notes=notes,
                      variables=names, input_plot=input_plot)

    # solve
    eq = value if isinstance(value, sp.Equality) else sp.Eq(value, 0)
    if not isinstance(value, sp.Equality):
        notes.append("There is no \"=\" sign, so this was solved as: expression = 0.")
    eq_names = [s.name for s in _symbols(eq)]
    var = _pick_variable(eq_names, wanted, "solve for")
    if not eq_names:
        raise MathInputError("There is no variable to solve for. Put a letter such as x in the equation.")
    if var.name not in eq_names:
        raise MathInputError(f"The equation does not contain {var.name}.")
    domain = sp.S.Complexes if req.get("domain") == "complex" else sp.S.Reals
    try:
        sol = sp.solveset(eq, var, domain=domain)
    except (NotImplementedError, ValueError, TypeError) as e:
        raise MathInputError(f"SymPy could not solve this equation ({_short(e)}).") from e
    if isinstance(sol, sp.ConditionSet):
        raise MathInputError("SymPy could not find a closed-form solution. Try plotting both sides and reading off where they cross.")
    solutions: list[dict] = []
    if isinstance(sol, sp.FiniteSet):
        for s in sorted(sol.args, key=lambda a: (not a.is_real, sp.default_sort_key(a))):
            solutions.append({"latex": _latex(s), "text": _text(s), "numeric": None if s.is_Integer or s.is_Rational and s.q == 1 else _numeric(s, 8)})
        if not solutions:
            notes.append("There are no real solutions." if domain == sp.S.Reals else "There are no solutions.")
        elif domain == sp.S.Reals:
            notes.append("Real solutions only. Tick the box to include complex ones.")
    elif sol == sp.S.EmptySet:
        notes.append("There are no real solutions." if domain == sp.S.Reals else "There are no solutions.")
    elif sol == domain:
        notes.append("Every value works: this is true for all " + ("real numbers." if domain == sp.S.Reals else "numbers."))
    else:
        notes.append("This has infinitely many solutions, shown as a family or a range.")
    shown_eq = shown if isinstance(shown, sp.Equality) else sp.Eq(shown, 0, evaluate=False)
    if isinstance(sol, sp.FiniteSet) and solutions:
        result_latex = r",\quad ".join(f"{_latex(var)} = {x['latex']}" for x in solutions)
    else:
        result_latex = _latex(var) + r" \in " + _latex(sol)
    return {
        "operation": "solve",
        "input_latex": _latex(shown_eq),
        "statement_latex": None,
        "result_latex": result_latex,
        "result_text": _text(sol),
        "numeric": None,
        "plot_text": None,
        "input_plot_text": None,
        "variables": eq_names,
        "notes": notes,
        "solutions": solutions,
        "solved_for": var.name,
    }


def handle(req: Any) -> dict:
    if not isinstance(req, dict):
        return {"error": "The request was not understood."}
    try:
        return run(req)
    except MathInputError as e:
        return {"error": str(e)}
    except RecursionError:
        return {"error": "This is too deeply nested to work out. Try a simpler expression."}
    except (ValueError, TypeError, ZeroDivisionError, NotImplementedError, OverflowError, ArithmeticError) as e:
        return {"error": f"SymPy could not work this out ({_short(e)})."}


def main() -> None:
    try:
        req = json.loads(sys.stdin.read(100_000))
    except ValueError:
        out = {"error": "The request was not understood."}
    else:
        out = handle(req)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()