const { ESLint } = require("eslint")

/** @type {import("lint-staged").Config} */
const config = {
  "*": async (filenames) => {
    const eslintFileExtensions = [".js", ".jsx", ".ts", ".tsx"]
    const eslintFilenames = filenames.filter((filename) =>
      eslintFileExtensions.some((extension) => filename.endsWith(extension)),
    )

    return [
      `eslint --fix ${await removeEslintIgnoredFiles(eslintFilenames)}`,
      `prettier --ignore-unknown --write ${filenames.map((file) => `"${file}"`).join(" ")}`,
    ]
  },
}

module.exports = config

/** @param {string[]} files */
const removeEslintIgnoredFiles = async (files) => {
  const eslint = new ESLint()
  const isIgnored = await Promise.all(
    files.map((file) => {
      return eslint.isPathIgnored(file)
    }),
  )
  const filteredFiles = files.filter((_, i) => !isIgnored[i])
  return filteredFiles.join(" ")
}
