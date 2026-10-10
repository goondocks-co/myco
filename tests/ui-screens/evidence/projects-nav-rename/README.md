# Projects navigation and rename

Fixture screenshots from the built Deployment dashboard. Screen checks cover admin and member navigation, Project settings, and the shared rename dialog at desktop, tablet, and phone widths in light and dark.

| Width | Mode | Admin navigation | Project settings | Rename dialog |
| --- | --- | --- | --- | --- |
| desktop | dark | [Navigation](shell-admin-desktop-dark.png) | [Settings](project-rename-settings-desktop-dark.png) | [Rename](project-rename-dialog-desktop-dark.png) |
| desktop | light | [Navigation](shell-admin-desktop-light.png) | [Settings](project-rename-settings-desktop-light.png) | [Rename](project-rename-dialog-desktop-light.png) |
| tablet | dark | [Navigation](shell-admin-drawer-tablet-dark.png) | [Settings](project-rename-settings-tablet-dark.png) | [Rename](project-rename-dialog-tablet-dark.png) |
| tablet | light | [Navigation](shell-admin-drawer-tablet-light.png) | [Settings](project-rename-settings-tablet-light.png) | [Rename](project-rename-dialog-tablet-light.png) |
| phone | dark | [Navigation](shell-admin-drawer-phone-dark.png) | [Settings](project-rename-settings-phone-dark.png) | [Rename](project-rename-dialog-phone-dark.png) |
| phone | light | [Navigation](shell-admin-drawer-phone-light.png) | [Settings](project-rename-settings-phone-light.png) | [Rename](project-rename-dialog-phone-light.png) |

Run: `npm run test:screens -- --grep "shell (admin|member)|project.settings admin|project rename settings" --workers 2`.

The lane used a scratch-only Playwright setup override to start the fixture server with its working directory inside the lane scratch directory.
