Option Explicit
Dim fso, sh, scriptDir, rosettaRoot, envNode, nodeBin, launcherPath, i, arg, argStr, waitMode, cmd, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rosettaRoot = fso.GetAbsolutePathName(fso.BuildPath(scriptDir, "..\.."))
launcherPath = fso.BuildPath(scriptDir, "launcher.cjs")
envNode = sh.ExpandEnvironmentStrings("%ROSETTA_NODE_BIN%")

If envNode <> "%ROSETTA_NODE_BIN%" And fso.FileExists(envNode) Then
  nodeBin = envNode
Else
  nodeBin = "node.exe"
End If

argStr = ""
waitMode = False
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If arg = "--smoke" Or arg = "--dry-run" Then
    waitMode = True
  End If
  argStr = argStr & " """ & Replace(arg, """", "") & """"
Next

sh.CurrentDirectory = rosettaRoot
cmd = """" & nodeBin & """ """ & launcherPath & """" & argStr
rc = sh.Run(cmd, 0, waitMode)
If waitMode Then
  WScript.Quit rc
End If
