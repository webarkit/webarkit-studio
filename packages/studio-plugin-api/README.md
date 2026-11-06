# @webarkit/studio-plugin-api

The types a [WebARKit Studio](https://github.com/webarkit/webarkit-studio) plugin is written against. Types only: nothing of the studio ends up in a plugin's bundle.

```ts
import type { StudioPlugin } from '@webarkit/studio-plugin-api';
```

[Writing a plugin](https://github.com/webarkit/webarkit-studio/blob/master/docs/plugins.md) explains how to use them.

The major version is the plugin API version a plugin targets, the `apiVersion` of its manifest. A breaking change, such as a change to a shared socket type, bumps both.
