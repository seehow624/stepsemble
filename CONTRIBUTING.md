# Contributing to Stepsemble

Thanks for helping improve Stepsemble.

1. Open an issue for substantial behavior or protocol changes.
2. Keep English as the source language and update every locale when adding UI
   text. A locale must not contain accidental copy from another language.
3. Never commit tokens, private URLs, device names, session data, project
   content, provider credentials, or usage history.
4. Keep runtime dependencies at zero unless a clear deployment benefit
   outweighs the added installation and update cost.
5. Run the checks before opening a pull request:

   ```bash
   zsh -n install.sh uninstall.sh deploy/*.sh
   npm run check
   npm test
   ```

By contributing, you agree that your work is licensed under the MIT License.

