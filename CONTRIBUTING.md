# Contributing

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- what you saw and what you expected;
- where: desktop app or terminal, and your Claude Code version (`claude --version`);
- a screenshot of the pane if it's a drawing problem.

Please don't paste your `stats-cache.json`: it's your usage history. A couple of made-up lines in the same shape are enough.

## Making a change

1. Fork the repo and clone your fork.
2. Run your copy with `claude --plugin-dir .`.
3. Make the change in `hooks/register.tsx`, and add or update a test in `tests/pane.test.tsx` for anything with logic in it.
4. Before opening a pull request, both of these must pass:

   ```bash
   claude plugin validate .
   claude plugin test .
   ```

5. Check the pane on both surfaces the tests cover, the desktop app and the terminal, if your change touches the drawing.

## Guidelines

- Keep it dependency-free and offline: the mod only reads Claude Code's own stats file.
- Match the style of the surrounding code; keep changes small and focused.
- One feature or fix per pull request.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
