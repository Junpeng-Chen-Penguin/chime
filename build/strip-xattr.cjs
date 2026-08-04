// 打包后、签名前清掉扩展属性（com.apple.provenance 等）。
// macOS 会给构建进程写出的文件盖溯源标记，codesign 见到即拒签
// （"resource fork, Finder information, or similar detritus not allowed"）。
// 逐文件删两类标记：FinderInfo 是 codesign 报 detritus 的直接触发物；
// fpfs#P 是 iCloud 文件同步（~/Documents 在同步范围内）打的，同步服务会持续
// 给新文件补标记，所以还需 mac.timestamp: none 把签名压到秒级，缩小竞态窗口
const { execSync } = require('child_process')
exports.default = async (context) => {
  console.log(`  • strip-xattr   dir=${context.appOutDir}`)
  const strip = (attr) =>
    execSync(`find "${context.appOutDir}" -exec xattr -d '${attr}' {} \\; 2>/dev/null; true`, { shell: '/bin/bash' })
  strip('com.apple.FinderInfo')
  strip('com.apple.fileprovider.fpfs#P')
}
