import './assets/fonts/misans/misans.css'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { toastRawError } from './lib/toast'

// 写操作失败的兜底（016 Case 1 功能点 7）：没人接的异步失败一律弹 Toast，不允许静默。
// 接的是所有漏网 rejection（读操作也会进来），各处该就地处理的照产品方案逐处做
window.addEventListener('unhandledrejection', (e) => {
  toastRawError(String((e.reason as Error)?.message ?? e.reason ?? '操作失败'))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
