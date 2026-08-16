Option Explicit

Dim shell, helperPath, updateMode, outputPath, commandLine, exitCode
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count <> 3 Then WScript.Quit 64

helperPath = WScript.Arguments(0)
updateMode = WScript.Arguments(1)
outputPath = WScript.Arguments(2)

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

commandLine = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
  & QuoteArgument(helperPath) & " -Mode " & QuoteArgument(updateMode) & " -OutputPath " & QuoteArgument(outputPath)

exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode
